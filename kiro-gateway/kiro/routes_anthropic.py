# -*- coding: utf-8 -*-

# Kiro Gateway
# https://github.com/jwadow/kiro-gateway
# Copyright (C) 2025 Jwadow
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""
FastAPI routes for Anthropic Messages API.

Contains the /v1/messages endpoint compatible with Anthropic's Messages API.

Reference: https://docs.anthropic.com/en/api/messages
"""

import json
import os
import asyncio
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Security, Header
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import APIKeyHeader
from loguru import logger

from kiro.config import PROXY_API_KEY, WEB_SEARCH_ENABLED, ALLOW_ANY_ANTHROPIC_KEY, KIRO_EMPTY_FLATTEN_RECOVERY
from kiro.config import WEB_SEARCH_CONTINUE, WEB_SEARCH_MAX_ROUNDS
from kiro.config import ELIDE_STALE_TOOL_IMAGES, ELIDE_STALE_TOOL_IMAGES_KEEP, ELIDE_STALE_TOOL_IMAGES_MIN_LEN
from kiro.models_anthropic import (
    AnthropicMessagesRequest,
    AnthropicMessagesResponse,
    AnthropicErrorResponse,
    AnthropicErrorDetail,
)
from kiro.auth import KiroAuthManager, AuthType
from kiro.cache import ModelInfoCache
from kiro.converters_anthropic import anthropic_to_kiro
from kiro.streaming_anthropic import (
    stream_kiro_to_anthropic,
    collect_anthropic_response,
)
from kiro.http_client import KiroHttpClient
from kiro.utils import generate_conversation_id
from kiro.tokenizer import count_tools_tokens, count_tokens, count_message_tokens, count_payload_tokens

# Import debug_logger
try:
    from kiro.debug_logger import debug_logger
except ImportError:
    debug_logger = None


def _flatten_request_for_recovery(request_data, conversation_id, profile_arn):
    """
    Build a Kiro payload with the conversation's structured tool_use / tool_result
    blocks flattened into plain narrative text.

    LAST-RESORT recovery only: opus-4.8 intermittently returns a zero-output
    completion on requests carrying many structured tool_use/tool_result blocks.
    Converting those historical blocks to text ("[called X with {...}]" /
    "[tool result] ...") removes the structural trigger while preserving the
    information. Tool DEFINITIONS are intentionally KEPT (request_data.tools is
    untouched) so the model can still call tools on the recovered turn.

    Returns (payload, tool_name_map) just like anthropic_to_kiro, or raises.
    """
    rd = request_data.model_copy(deep=True)
    new_messages = []
    for msg in rd.messages:
        content = msg.content
        if not isinstance(content, list):
            new_messages.append(msg)
            continue
        parts = []
        for block in content:
            btype = block.get("type") if isinstance(block, dict) else getattr(block, "type", None)
            def _bget(b, k, default=None):
                return b.get(k, default) if isinstance(b, dict) else getattr(b, k, default)
            if btype == "text":
                t = _bget(block, "text", "") or ""
                if t:
                    parts.append(t)
            elif btype == "thinking":
                # drop replayed thinking from flattened history (kept-last handled elsewhere)
                continue
            elif btype == "tool_use":
                name = _bget(block, "name", "") or "tool"
                inp = _bget(block, "input", {})
                try:
                    inp_s = json.dumps(inp, ensure_ascii=False)
                except Exception:
                    inp_s = str(inp)
                parts.append(f"[called {name} with {inp_s[:600]}]")
            elif btype == "tool_result":
                rc = _bget(block, "content", "")
                if isinstance(rc, list):
                    sub = []
                    for s in rc:
                        st = s.get("type") if isinstance(s, dict) else getattr(s, "type", None)
                        if st == "text":
                            sub.append((s.get("text") if isinstance(s, dict) else getattr(s, "text", "")) or "")
                    rc = "\n".join(sub)
                if not isinstance(rc, str):
                    try:
                        rc = json.dumps(rc, ensure_ascii=False)
                    except Exception:
                        rc = str(rc)
                parts.append("[tool result] " + rc)
            else:
                # images / other: keep a marker, don't crash
                parts.append(f"[{btype}]")
        flat_text = "\n".join(p for p in parts if p) or "."
        new_messages.append(msg.model_copy(update={"content": flat_text}))
    rd.messages = new_messages
    return anthropic_to_kiro(rd, conversation_id, profile_arn)


def _build_web_search_continuation_request(request_data, ws_state, force_answer):
    """
    Build an AnthropicMessagesRequest for a WebSearch Path B continuation round (Option 2).

    messages = original messages
             + assistant: [ model text-so-far (if any) + the <web_search>…</web_search> digest ]
             + user:      [ short instruction to answer using the results above ]

    The digest is carried as TEXT (the only channel pi preserves across turns), so the
    continuation model actually receives the results. `force_answer` (set on the round that
    REACHES the cap) strips the web_search tool so the model cannot search again and must
    produce a grounded answer -> the turn terminates deterministically.
    """
    from kiro.models_anthropic import AnthropicMessage
    rd = request_data.model_copy(deep=True)

    summary = (ws_state.get("summary") or "").strip()
    text_so_far = (ws_state.get("text_so_far") or "").strip()
    assistant_text = (text_so_far + "\n\n" + summary) if text_so_far else summary
    if not assistant_text:
        assistant_text = "(web search returned no results)"

    if force_answer:
        instruction = ("Use the web_search results above to answer my request directly and "
                       "completely. Do not call web_search again.")
    else:
        instruction = ("Use the web_search results above to answer my request. Only call "
                       "web_search again if essential information is still missing.")

    rd.messages = list(rd.messages) + [
        AnthropicMessage(role="assistant", content=[{"type": "text", "text": assistant_text}]),
        AnthropicMessage(role="user", content=[{"type": "text", "text": instruction}]),
    ]

    # web_search is only in rd.tools because the route injected it (Path B) for a request that
    # did NOT opt out via x-no-web-search. Keep it available so a continuation can search again,
    # EXCEPT on the capped round where we strip it to force termination.
    if force_answer and rd.tools:
        rd.tools = [t for t in rd.tools if getattr(t, "name", None) != "web_search"]

    return rd


# --- Security scheme ---
# Anthropic uses x-api-key header instead of Authorization: Bearer
anthropic_api_key_header = APIKeyHeader(name="x-api-key", auto_error=False)
# Also support Authorization: Bearer for compatibility
auth_header = APIKeyHeader(name="Authorization", auto_error=False)


async def verify_anthropic_api_key(
    x_api_key: Optional[str] = Security(anthropic_api_key_header),
    authorization: Optional[str] = Security(auth_header)
) -> bool:
    """
    Verify API key for Anthropic API.

    Supports two authentication methods:
    1. x-api-key header (Anthropic native)
    2. Authorization: Bearer header (for compatibility)

    When ALLOW_ANY_ANTHROPIC_KEY is enabled (default), any non-empty key is
    accepted. This lets clients like Claude Code Desktop work even when they
    send their own OAuth token (sk-ant-oat...) instead of the proxy key.
    The client key is consumed at the gateway boundary — it is never
    forwarded to Kiro.

    Args:
        x_api_key: Value from x-api-key header
        authorization: Value from Authorization header

    Returns:
        True if key is valid

    Raises:
        HTTPException: 401 if key is invalid or missing
    """
    # Check x-api-key first (Anthropic native)
    if x_api_key and x_api_key == PROXY_API_KEY:
        return True

    # Fall back to Authorization: Bearer
    if authorization and authorization == f"Bearer {PROXY_API_KEY}":
        return True

    # Permissive mode: accept any non-empty key (local proxy convenience)
    if ALLOW_ANY_ANTHROPIC_KEY:
        bearer_token = None
        if authorization and authorization.startswith("Bearer "):
            bearer_token = authorization[len("Bearer "):].strip()
        if (x_api_key and x_api_key.strip()) or (bearer_token):
            return True

    def _redact(value: Optional[str], keep: int = 4) -> str:
        if not value:
            return "<missing>"
        return f"{value[:keep]}…(len={len(value)})"

    logger.warning(
        "Access attempt with invalid API key (Anthropic endpoint) | "
        f"x-api-key={_redact(x_api_key)} | authorization={_redact(authorization, keep=16)}"
    )
    raise HTTPException(
        status_code=401,
        detail={
            "type": "error",
            "error": {
                "type": "authentication_error",
                "message": "Invalid or missing API key. Use x-api-key header or Authorization: Bearer."
            }
        }
    )


# --- Router ---
router = APIRouter(tags=["Anthropic API"])


@router.post("/v1/messages", dependencies=[Depends(verify_anthropic_api_key)])
async def messages(
    request: Request,
    request_data: AnthropicMessagesRequest,
    anthropic_version: Optional[str] = Header(None, alias="anthropic-version")
):
    """
    Anthropic Messages API endpoint.
    
    Compatible with Anthropic's /v1/messages endpoint.
    Accepts requests in Anthropic format and translates them to Kiro API.
    
    Required headers:
    - x-api-key: Your API key (or Authorization: Bearer)
    - anthropic-version: API version (optional, for compatibility)
    - Content-Type: application/json
    
    Args:
        request: FastAPI Request for accessing app.state
        request_data: Request in Anthropic MessagesRequest format
        anthropic_version: Anthropic API version header (optional)
    
    Returns:
        StreamingResponse for streaming mode (SSE)
        JSONResponse for non-streaming mode
    
    Raises:
        HTTPException: On validation or API errors
    """
    logger.info(f"Request to /v1/messages (model={request_data.model}, stream={request_data.stream})")
    
    if anthropic_version:
        logger.debug(f"Anthropic-Version header: {anthropic_version}")
    
    auth_manager: KiroAuthManager = request.app.state.auth_manager
    model_cache: ModelInfoCache = request.app.state.model_cache
    
    # Note: prepare_new_request() and log_request_body() are now called by DebugLoggerMiddleware
    # This ensures debug logging works even for requests that fail Pydantic validation (422 errors)
    
    # Check for truncation recovery opportunities
    from kiro.truncation_state import get_tool_truncation, get_content_truncation
    from kiro.truncation_recovery import generate_truncation_tool_result, generate_truncation_user_message
    from kiro.models_anthropic import AnthropicMessage
    
    # --- Anti-poison: repair empty assistant messages -----------------------
    # A turn that returned an empty completion (content == [] / "" / no real
    # blocks) gets written into the conversation history. Because the full
    # history is replayed every request, that empty assistant turn poisons the
    # conversation — every later turn (including a manual "Continue") then also
    # comes back empty and the session can't recover. Replace any empty
    # assistant message with a minimal non-empty placeholder so history stays
    # valid and the model resumes normally.
    # Known gateway/agent placeholder strings. If these accumulate in history the
    # model (especially opus-4.7) can start MIMICKING them, emitting e.g. "(no
    # output)" as its own "answer" -> a non-empty-looking turn that is really an
    # empty response. We strip them from history (so the pattern disappears) and
    # also treat a fresh placeholder-only completion as empty (see stream_wrapper).
    _KNOWN_PLACEHOLDERS = ("(no output)", "(empty placeholder)", "(continuing)")
    _PH_LOWER = tuple(p.lower() for p in _KNOWN_PLACEHOLDERS)
    _PH_LOWER_SET = set(_PH_LOWER)

    def _is_placeholder_text(txt) -> bool:
        return (txt or "").strip().lower() in _PH_LOWER_SET

    def _text_is_placeholderish(acc) -> bool:
        # True while the leading text is empty or still a prefix of (or equal to) a
        # known placeholder -> ambiguous, keep buffering. False once it diverges
        # (clearly real text) so streaming resumes with negligible delay.
        s = (acc or "").strip().lower()
        if s == "":
            return True
        return any(p.startswith(s) for p in _PH_LOWER)

    def _sse_parse(chunk):
        # minimal SSE chunk -> (event_type, data_dict|None)
        _et = None
        _payload = None
        for _ln in chunk.split("\n"):
            if _ln.startswith("event:"):
                _et = _ln[6:].strip()
            elif _ln.startswith("data:"):
                _d = _ln[5:].strip()
                if _d:
                    try:
                        _payload = json.loads(_d)
                    except Exception:
                        _payload = None
        return _et, _payload

    def _shift_block_index(chunk, _et, _pl, by):
        # Re-serialize a content_block_* / message_delta-usage chunk with its block
        # `index` bumped by `by`. Used ONLY on the rare flatten-recovery pass so the
        # recovered content's blocks sit after the index-0 "fixing" status block and
        # never collide. No effect on the normal path.
        if by == 0 or not _pl or not isinstance(_pl, dict):
            return chunk
        if _et in ("content_block_start", "content_block_delta", "content_block_stop") and "index" in _pl:
            try:
                _pl = dict(_pl)
                _pl["index"] = int(_pl.get("index", 0)) + by
                return f"event: {_et}\ndata: {json.dumps(_pl)}\n\n"
            except Exception:
                return chunk
        return chunk

    def _is_empty_assistant_content(content) -> bool:
        if content is None:
            return True
        if isinstance(content, str):
            return content.strip() == "" or _is_placeholder_text(content)
        if isinstance(content, list):
            for b in content:
                bt = b.get("type") if isinstance(b, dict) else getattr(b, "type", None)
                if bt in ("tool_use", "thinking", "redacted_thinking", "image"):
                    return False
                if bt == "text":
                    txt = b.get("text") if isinstance(b, dict) else getattr(b, "text", "")
                    if (txt or "").strip() and not _is_placeholder_text(txt):
                        return False
            return True
        return False

    # --- History sanitizer (root-cause fix for empty completions) -----------
    # ROOT CAUSE: replaying prior-turn `thinking` blocks while extended thinking
    # (effort) is enabled makes Kiro/CodeWhisperer return an EMPTY completion; the
    # failure grows with the number of accumulated historical thinking blocks.
    # But thinking blocks hold the model's reasoning, so we don't blindly drop all
    # of them. Mode-controlled (x-thinking-mode header > KIRO_THINKING_HISTORY env
    # > default), where N = KIRO_THINKING_KEEP_LAST (default 1):
    #   keep_last (default): keep thinking only on the most-recent N assistant
    #       turns (the active reasoning the model needs to continue a tool loop);
    #       strip it from older, completed turns (which the model re-derives fresh
    #       each turn under effort=max). Preserves smartness, avoids the empty.
    #   keep_last_nosig: keep_last but drop signatures.   nosig: keep all, no sig.
    #   strip: remove all thinking.   keep: passthrough (debug only).
    # Empty assistant turns are always repaired to a non-empty placeholder.
    def _blk_get(_b, _k):
        return _b.get(_k) if isinstance(_b, dict) else getattr(_b, _k, None)

    _tmode = (request.headers.get("x-thinking-mode")
              or os.getenv("KIRO_THINKING_HISTORY") or "keep").strip().lower()
    try:
        _keepN = int(request.headers.get("x-thinking-keep") or os.getenv("KIRO_THINKING_KEEP_LAST") or "1")
    except Exception:
        _keepN = 1
    # positions (message_index, block_index) of every thinking block, in order
    _think_pos = []
    for _i, _mm in enumerate(request_data.messages):
        _cc = _mm.content
        if _mm.role == "assistant" and isinstance(_cc, list):
            for _j, _bb in enumerate(_cc):
                if _blk_get(_bb, "type") in ("thinking", "redacted_thinking"):
                    _think_pos.append((_i, _j))
    _keep_pos = set(_think_pos[-_keepN:]) if _keepN > 0 else set()

    _empty_fixed = 0
    _thinking_removed = 0
    _sig_dropped = 0
    _ph_stripped = 0
    _sanitized = []
    for _i, _m in enumerate(request_data.messages):
        if _m.role != "assistant":
            _sanitized.append(_m)
            continue
        _content = _m.content
        _changed = False
        if isinstance(_content, list):
            _kept = []
            for _j, _b in enumerate(_content):
                _bt = _blk_get(_b, "type")
                if _bt in ("thinking", "redacted_thinking"):
                    if _tmode == "keep" or _tmode == "nosig":
                        _keep_here = True
                    elif _tmode == "strip":
                        _keep_here = False
                    else:  # keep_last / keep_last_nosig
                        _keep_here = (_i, _j) in _keep_pos
                    if not _keep_here:
                        _thinking_removed += 1
                        _changed = True
                        continue
                    if _tmode in ("nosig", "keep_last_nosig"):
                        _kept.append({"type": _bt, "thinking": _blk_get(_b, "thinking") or _blk_get(_b, "text") or ""})
                        _sig_dropped += 1
                        _changed = True
                    else:
                        _kept.append(_b)
                elif _bt == "text" and _is_placeholder_text(_blk_get(_b, "text")):
                    # drop placeholder-only text blocks so the model can't learn to
                    # mimic them (it was emitting "(no output)"/"(empty placeholder)")
                    _ph_stripped += 1
                    _changed = True
                else:
                    _kept.append(_b)
            _content = _kept
        if _is_empty_assistant_content(_content):
            _sanitized.append(_m.model_copy(update={"content": [{"type": "text", "text": "(continuing)"}]}))
            _empty_fixed += 1
        elif _changed:
            _sanitized.append(_m.model_copy(update={"content": _content}))
        else:
            _sanitized.append(_m)
    if _empty_fixed or _thinking_removed or _sig_dropped or _ph_stripped:
        request_data.messages = _sanitized
        logger.info(f"History sanitized [mode={_tmode},keepN={_keepN}]: thinking_removed={_thinking_removed}, sig_dropped={_sig_dropped}, empty_repaired={_empty_fixed}, placeholders_stripped={_ph_stripped}")

    # --- Stale tool_result IMAGE eliding (root-cause fix for empty completions) ---
    # ROOT CAUSE (proven 2026-06-18 by deterministic replay): large base64 image data
    # (browser_live screenshots / read-image results) carried in tool_result blocks is
    # the dominant opus-4.8 empty trigger at scale. A real 114k request with 7 PNG
    # blobs (~1.85M b64 chars) was 3/3 EMPTY; removing the images was 0/3 OK. Old
    # screenshots in HISTORY are rarely needed as pixels once the model has acted on
    # them, but they poison every subsequent turn. Keep the most-recent N images intact
    # (the model may still reason about what it just saw) and elide older base64 image
    # data to a tiny text note, preserving that an image existed. Gated
    # ELIDE_STALE_TOOL_IMAGES (default on), N = ELIDE_STALE_TOOL_IMAGES_KEEP (default 1).
    if ELIDE_STALE_TOOL_IMAGES:
        def _g(_o, _k):
            return _o.get(_k) if isinstance(_o, dict) else getattr(_o, _k, None)
        # Gather (tool_result_block, index_within_its_content_list, image_block) for every
        # image carried in a tool_result, in conversation order.
        _img_slots = []  # list of (parent_tr_block, image_block)
        for _m in request_data.messages:
            if getattr(_m, "role", None) != "user" or not isinstance(_m.content, list):
                continue
            for _b in _m.content:
                if _g(_b, "type") != "tool_result":
                    continue
                _trc = _g(_b, "content")
                if not isinstance(_trc, list):
                    continue
                for _blk in _trc:
                    if _g(_blk, "type") in ("image", "image_url"):
                        _img_slots.append((_b, _blk))
        _keep_imgs = set(id(blk) for (_, blk) in _img_slots[-ELIDE_STALE_TOOL_IMAGES_KEEP:]) if ELIDE_STALE_TOOL_IMAGES_KEEP > 0 else set()
        _elided_imgs = 0
        _elided_chars = 0
        for _tr, _blk in _img_slots:
            if id(_blk) in _keep_imgs:
                continue
            _src = _g(_blk, "source")
            _data = _g(_src, "data") if _src is not None else None
            if not (_data and len(_data) > ELIDE_STALE_TOOL_IMAGES_MIN_LEN):
                continue
            _mt = (_g(_src, "media_type") or "image")
            # Remove the image block from its parent tool_result.content list and add a
            # text note in its place (proven fix: removing the base64 image stops the
            # opus-4.8 empty; a 1x1 PNG replacement is rejected by Bedrock with 400).
            _parent_content = _g(_tr, "content")
            if not isinstance(_parent_content, list):
                continue
            try:
                _parent_content.remove(_blk)
            except ValueError:
                continue
            # Build the replacement note as the SAME shape as the sibling blocks so the
            # later model_dump() stays valid: if siblings are pydantic objects, build a
            # TextContentBlock; if dicts, use a dict.
            _note_text = f"[stale {_mt} screenshot elided: {len(_data)} b64 chars]"
            _sibling_is_dict = any(isinstance(_x, dict) for _x in _parent_content) or not _parent_content
            if _sibling_is_dict:
                _parent_content.append({"type": "text", "text": _note_text})
            else:
                from kiro.models_anthropic import TextContentBlock as _TCB
                _parent_content.append(_TCB(type="text", text=_note_text))
            _elided_chars += len(_data)
            _elided_imgs += 1
        if _elided_imgs:
            logger.info(f"Stale tool_result images elided: {_elided_imgs} (~{_elided_chars} b64 chars freed, kept last {ELIDE_STALE_TOOL_IMAGES_KEEP})")

    modified_messages = []
    tool_results_modified = 0
    content_notices_added = 0
    
    for msg in request_data.messages:
        # Check if this is a user message with tool_result blocks
        if msg.role == "user" and msg.content and isinstance(msg.content, list):
            modified_content_blocks = []
            has_modifications = False
            
            for block in msg.content:
                # Handle both dict and Pydantic objects (ToolResultContentBlock)
                if isinstance(block, dict):
                    block_type = block.get("type")
                    tool_use_id = block.get("tool_use_id")
                    original_content = block.get("content", "")
                elif hasattr(block, "type"):
                    block_type = block.type
                    tool_use_id = getattr(block, "tool_use_id", None)
                    original_content = getattr(block, "content", "")
                else:
                    modified_content_blocks.append(block)
                    continue
                
                if block_type == "tool_result" and tool_use_id:
                    truncation_info = get_tool_truncation(tool_use_id)
                    if truncation_info:
                        # Modify tool_result content to include truncation notice
                        synthetic = generate_truncation_tool_result(
                            tool_name=truncation_info.tool_name,
                            tool_use_id=tool_use_id,
                            truncation_info=truncation_info.truncation_info
                        )
                        # Prepend truncation notice to original content
                        modified_content = f"{synthetic['content']}\n\n---\n\nOriginal tool result:\n{original_content}"
                        
                        # Create modified block (handle both dict and Pydantic)
                        if isinstance(block, dict):
                            modified_block = block.copy()
                            modified_block["content"] = modified_content
                        else:
                            # Pydantic object - use model_copy
                            modified_block = block.model_copy(update={"content": modified_content})
                        
                        modified_content_blocks.append(modified_block)
                        tool_results_modified += 1
                        has_modifications = True
                        logger.debug(f"Modified tool_result for {tool_use_id} to include truncation notice")
                        continue
                
                modified_content_blocks.append(block)
            
            # Create NEW AnthropicMessage object if modifications were made (Pydantic immutability)
            if has_modifications:
                modified_msg = msg.model_copy(update={"content": modified_content_blocks})
                modified_messages.append(modified_msg)
                continue  # Skip normal append since we already added modified version
        
        # Check if this is an assistant message with truncated content
        if msg.role == "assistant" and msg.content:
            # Extract text content for hash check
            text_content = ""
            if isinstance(msg.content, str):
                text_content = msg.content
            elif isinstance(msg.content, list):
                for block in msg.content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text_content += block.get("text", "")
            
            if text_content:
                truncation_info = get_content_truncation(text_content)
                if truncation_info:
                    # Add this message first
                    modified_messages.append(msg)
                    # Then add synthetic user message about truncation
                    synthetic_user_msg = AnthropicMessage(
                        role="user",
                        content=[{"type": "text", "text": generate_truncation_user_message()}]
                    )
                    modified_messages.append(synthetic_user_msg)
                    content_notices_added += 1
                    logger.debug(f"Added truncation notice after assistant message (hash: {truncation_info.message_hash})")
                    continue  # Skip normal append since we already added it
        
        modified_messages.append(msg)
    
    if tool_results_modified > 0 or content_notices_added > 0:
        request_data.messages = modified_messages
        logger.info(f"Truncation recovery: modified {tool_results_modified} tool_result(s), added {content_notices_added} content notice(s)")

    # ==========================================================================
    # WebSearch — Path B: auto-inject web_search as a regular tool
    # Model decides whether to use it; streaming layer intercepts the call.
    # ==========================================================================
    if WEB_SEARCH_ENABLED:
        # Per-request opt-out: callers that must NOT get web_search auto-injected
        # (e.g. an extension's compaction/summarization call) send x-no-web-search.
        # Without this, opus-4.x sees a web_search tool, decides to "research" the
        # prompt, and the gateway returns SEARCH RESULTS as the response body — which
        # corrupted compaction summaries (observed: a summary that was just
        # <web_search>…</web_search> results, poisoning the next compaction).
        _no_ws = (request.headers.get("x-no-web-search") or "").strip().lower() in ("1", "true", "yes")
        if _no_ws:
            logger.info("web_search auto-injection skipped (x-no-web-search)")
        else:
            if request_data.tools is None:
                request_data.tools = []
            has_ws = any(getattr(t, "name", None) == "web_search" for t in request_data.tools)
            if not has_ws:
                from kiro.models_anthropic import AnthropicTool
                request_data.tools.append(AnthropicTool(
                    name="web_search",
                    description=(
                        "Search the web for current information. "
                        "Use when you need up-to-date data from the internet."
                    ),
                    input_schema={
                        "type": "object",
                        "properties": {"query": {"type": "string", "description": "Search query"}},
                        "required": ["query"],
                    },
                ))
                logger.debug("Auto-injected web_search tool (Path B)")

    # ==========================================================================
    # WebSearch — Path A: native Anthropic server-side tool → direct MCP call
    # This always runs regardless of WEB_SEARCH_ENABLED.
    # ==========================================================================
    if request_data.tools:
        for tool in request_data.tools:
            tool_type = getattr(tool, "type", None)
            if tool_type and tool_type.startswith("web_search"):
                from kiro.mcp_tools import handle_native_web_search
                logger.info("Detected native Anthropic web_search (Path A), routing to MCP API")
                return await handle_native_web_search(request, request_data, auth_manager)

    # Generate conversation ID for Kiro API (random UUID, not used for tracking)
    conversation_id = generate_conversation_id()
    
    # Build payload for Kiro
    # profileArn is only needed for Kiro Desktop auth
    profile_arn_for_payload = ""
    if auth_manager.auth_type == AuthType.KIRO_DESKTOP and auth_manager.profile_arn:
        profile_arn_for_payload = auth_manager.profile_arn
    
    try:
        kiro_payload, tool_name_map = anthropic_to_kiro(
            request_data,
            conversation_id,
            profile_arn_for_payload
        )
    except ValueError as e:
        logger.error(f"Conversion error: {e}")
        return JSONResponse(
            status_code=400,
            content={
                "type": "error",
                "error": {
                    "type": "invalid_request_error",
                    "message": str(e)
                }
            }
        )
    
    # Log Kiro payload
    try:
        kiro_request_body = json.dumps(kiro_payload, ensure_ascii=False, indent=2).encode('utf-8')
        if debug_logger:
            debug_logger.log_kiro_request_body(kiro_request_body)
    except Exception as e:
        logger.warning(f"Failed to log Kiro request: {e}")
    
    # Create HTTP client with retry logic
    # For streaming: use per-request client to avoid CLOSE_WAIT leak on VPN disconnect (issue #54)
    # For non-streaming: use shared client for connection pooling
    url = f"{auth_manager.api_host}/generateAssistantResponse"
    logger.debug(f"Kiro API URL: {url}")
    
    if request_data.stream:
        # Streaming mode: per-request client prevents orphaned connections
        # when network interface changes (VPN disconnect/reconnect)
        http_client = KiroHttpClient(auth_manager, shared_client=None)
    else:
        # Non-streaming mode: shared client for efficient connection reuse
        shared_client = request.app.state.http_client
        http_client = KiroHttpClient(auth_manager, shared_client=shared_client)
    
    # Prepare data for token counting
    # Convert Pydantic models to dicts for tokenizer
    messages_for_tokenizer = [msg.model_dump() for msg in request_data.messages]
    tools_for_tokenizer = [tool.model_dump() for tool in request_data.tools] if request_data.tools else None

    # Real input-token count. Count each component ONCE (system + messages +
    # tools). NOTE: do NOT recursively walk the kiro_payload — tool schemas get
    # traversed per-occurrence there and inflate the count ~10x (a ~219K context
    # read as ~2.1M, which made pi show 210% and over-compact). count_message_tokens
    # and count_tools_tokens already handle every structured block correctly.
    try:
        _sys_text = ""
        if request_data.system:
            if isinstance(request_data.system, str):
                _sys_text = request_data.system
            elif isinstance(request_data.system, list):
                _parts = []
                for _b in request_data.system:
                    _t = _b.get("text") if isinstance(_b, dict) else getattr(_b, "text", None)
                    if _t:
                        _parts.append(_t)
                _sys_text = "\n".join(_parts)
        _msg_tok = count_message_tokens(messages_for_tokenizer)
        _tool_tok = count_tools_tokens(tools_for_tokenizer)
        _sys_tok = count_tokens(_sys_text)
        real_input_tokens = _msg_tok + _tool_tok + _sys_tok
        logger.info(f"[tokens] real input = {real_input_tokens:,} (msgs={_msg_tok:,} tools={_tool_tok:,} sys={_sys_tok:,} n_tools={len(tools_for_tokenizer or [])})")
    except Exception as _e:
        logger.warning(f"[tokens] input token count failed: {_e}")
        real_input_tokens = None
    
    try:
        # Make request to Kiro API (for both streaming and non-streaming modes)
        # Important: we wait for Kiro response BEFORE returning StreamingResponse,
        # so that we can return proper HTTP error codes if Kiro fails
        response = await http_client.request_with_retry(
            "POST",
            url,
            kiro_payload,
            stream=True
        )
        
        if response.status_code != 200:
            try:
                error_content = await response.aread()
            except Exception:
                error_content = b"Unknown error"
            
            await http_client.close()
            error_text = error_content.decode('utf-8', errors='replace')
            
            # Try to parse JSON response from Kiro to extract error message
            error_message = error_text
            try:
                error_json = json.loads(error_text)
                # Enhance Kiro API errors with user-friendly messages
                from kiro.kiro_errors import enhance_kiro_error
                error_info = enhance_kiro_error(error_json)
                error_message = error_info.user_message
                # Log original error for debugging
                logger.debug(f"Original Kiro error: {error_info.original_message} (reason: {error_info.reason})")
            except (json.JSONDecodeError, KeyError):
                pass
            
            # Log access log for error (before flush, so it gets into app_logs)
            logger.warning(
                f"HTTP {response.status_code} - POST /v1/messages - {error_message[:100]}"
            )
            
            # Flush debug logs on error
            if debug_logger:
                debug_logger.flush_on_error(response.status_code, error_message)
            
            # Return error in Anthropic format
            return JSONResponse(
                status_code=response.status_code,
                content={
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "message": error_message
                    }
                }
            )
        
        if request_data.stream:
            # Streaming mode. Kiro intermittently returns a 200 with NO content
            # (a transient empty completion). We retry it transparently: emit the
            # message_start once, forward content blocks from whichever attempt
            # produces them, and drop+retry empty attempts. During retries we emit
            # SSE `ping` heartbeats so the client's read timeout never fires during a
            # long empty streak (otherwise pi would "terminate" the request). All
            # thinking is preserved; the placeholder is only a last-resort safety net.
            max_empty_retries = int(os.getenv("KIRO_EMPTY_RETRIES", "3"))
            # Flatten recovery rides out BOTH the request-shape empties (flatten fixes
            # them) AND short transient opus-4.8 empty waves (persistence + spacing
            # rides them out). Default 4, ceiling 8.
            max_flatten_retries = max(1, min(8, int(os.getenv("KIRO_EMPTY_FLATTEN_MAX", "4"))))
            max_ws_rounds = max(1, min(100, WEB_SEARCH_MAX_ROUNDS))
            _PING = 'event: ping\ndata: {"type": "ping"}\n\n'

            async def stream_wrapper():
                nonlocal response
                streaming_error = None
                client_disconnected = False
                empty_attempts = 0
                started = False  # whether the single message_start has been emitted
                flatten_attempts = 0  # flatten-recovery attempts used
                flatten_status_shown = False  # whether the "fixing" status was shown
                flatten_recovered = False  # streaming the flattened-recovery attempt (shift block idx +1)
                # --- WebSearch Path B fold-to-text continuation (Option 2) state ---
                block_offset = 0      # cumulative global base added to inner block indices
                max_idx_seen = -1     # highest GLOBAL content-block index emitted so far
                ws_rounds = 0         # number of web_search continuations performed
                active_payload = kiro_payload  # payload used by empty-retry re-request

                def _fwd(_chunk, _et2, _pl2):
                    # Shift this round's local block index into the global space and track the
                    # high-water mark so the NEXT round starts one past it. No-op when base == 0,
                    # so this is transparent for any turn without a web_search continuation.
                    nonlocal max_idx_seen
                    _by = block_offset + (1 if flatten_recovered else 0)
                    _out = _shift_block_index(_chunk, _et2, _pl2, _by)
                    if _et2 in ("content_block_start", "content_block_delta", "content_block_stop") \
                            and _pl2 and "index" in _pl2:
                        try:
                            _gi = int(_pl2.get("index", 0)) + _by
                            if _gi > max_idx_seen:
                                max_idx_seen = _gi
                        except Exception:
                            pass
                    return _out
                try:
                    while True:
                        # suppress the converter placeholder on all but the final
                        # attempt, so a truly-empty stream stays detectable/retryable
                        suppress = empty_attempts < max_empty_retries
                        got_content = False   # this attempt produced REAL content
                        _buf = []             # sniff buffer until we decide real/placeholder
                        _acc = ""             # accumulated leading text for placeholder sniff
                        ws_state = {}         # per-round WebSearch continuation side-channel
                        async for chunk in stream_kiro_to_anthropic(
                            response,
                            request_data.model,
                            model_cache,
                            auth_manager,
                            request_messages=messages_for_tokenizer,
                            tool_name_map=tool_name_map,
                            suppress_empty_placeholder=suppress,
                            real_input_tokens=real_input_tokens,
                            ws_continue_state=(ws_state if WEB_SEARCH_CONTINUE else None),
                        ):
                            _et, _pl = _sse_parse(chunk)
                            if _et == "message_start":
                                # emit exactly one message_start; on retry attempts
                                # send a heartbeat instead so the client stays alive
                                if not started:
                                    started = True
                                    yield chunk
                                else:
                                    yield _PING
                                continue
                            if got_content:
                                yield _fwd(chunk, _et, _pl)
                                continue
                            # --- not yet decided: buffer + sniff for placeholder mimicry ---
                            # A turn whose ONLY content is a known placeholder string
                            # (e.g. opus-4.7 returning just "(no output)") is a disguised
                            # empty completion -> buffer, and if nothing real arrives, retry.
                            _buf.append(chunk)
                            if _et == "content_block_start":
                                _bt = ((_pl or {}).get("content_block") or {}).get("type")
                                if _bt in ("tool_use", "thinking", "redacted_thinking", "image"):
                                    got_content = True
                            elif _et == "content_block_delta":
                                _d = (_pl or {}).get("delta") or {}
                                if _d.get("type") == "thinking_delta":
                                    got_content = True
                                elif _d.get("type") == "text_delta":
                                    _acc += _d.get("text") or ""
                                    # real text once it diverges from every placeholder
                                    if _acc.strip() and not _text_is_placeholderish(_acc):
                                        got_content = True
                            if got_content:
                                for _c in _buf:
                                    _cet, _cpl = _sse_parse(_c)
                                    yield _fwd(_c, _cet, _cpl)
                                _buf = []
                        # ---- WebSearch Path B fold-to-text continuation (Option 2) ----------
                        # A web_search was intercepted this round (the inner generator returned
                        # before its message_stop; the route owns the lifecycle). Resolve into a
                        # fresh upstream call and keep streaming under the SAME message. Runs
                        # BEFORE the got_content/empty logic so a search-only round (no text) is
                        # never mis-read as an empty completion.
                        if WEB_SEARCH_CONTINUE and ws_state.get("searched"):
                            ws_rounds += 1
                            _force = ws_rounds >= max_ws_rounds  # last allowed round -> force answer
                            block_offset = max_idx_seen + 1       # advance global index base
                            try:
                                _cont_req = _build_web_search_continuation_request(
                                    request_data, ws_state, force_answer=_force
                                )
                                active_payload, _ = anthropic_to_kiro(
                                    _cont_req, conversation_id, profile_arn_for_payload
                                )
                            except Exception as _ce:
                                logger.warning(f"web_search continuation build failed ({_ce}); ending turn gracefully")
                                _idx = block_offset
                                yield 'event: content_block_start\ndata: ' + json.dumps({"type": "content_block_start", "index": _idx, "content_block": {"type": "text", "text": ""}}) + "\n\n"
                                yield 'event: content_block_delta\ndata: ' + json.dumps({"type": "content_block_delta", "index": _idx, "delta": {"type": "text_delta", "text": ws_state.get("summary") or ""}}) + "\n\n"
                                yield 'event: content_block_stop\ndata: ' + json.dumps({"type": "content_block_stop", "index": _idx}) + "\n\n"
                                yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n'
                                yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                                break
                            logger.info(f"web_search continuation round {ws_rounds}/{max_ws_rounds} (force_answer={_force}); base index={block_offset}")
                            try:
                                await response.aclose()
                            except Exception:
                                pass
                            response = await http_client.request_with_retry("POST", url, active_payload, stream=True)
                            if response.status_code != 200:
                                try:
                                    _err = (await response.aread()).decode("utf-8", "replace")
                                except Exception:
                                    _err = "Unknown error"
                                yield f'event: error\ndata: {json.dumps({"type": "error", "error": {"type": "api_error", "message": _err[:200]}})}\n\n'
                                break
                            yield _PING  # heartbeat before the continuation round streams
                            continue     # resume OUTER loop to stream the continuation
                        if got_content:
                            break
                        # ---- nothing real this attempt (truly empty, or a placeholder-only
                        # completion like opus-4.7 emitting just "(no output)") -> retry ----
                        empty_attempts += 1
                        if empty_attempts > max_empty_retries:
                            # ---- LAST-RESORT FLATTEN RECOVERY (gated, up to N attempts) ----
                            # Normal retries are exhausted. opus-4.8 can keep returning
                            # zero-output on requests with many structured tool_use/
                            # tool_result blocks. Rebuild the payload with that history
                            # flattened to text (tool DEFINITIONS kept) and retry up to
                            # KIRO_EMPTY_FLATTEN_MAX times (each upstream call is a fresh
                            # roll; flatten is ~4/5 so a few tries compound the odds).
                            # Surface a visible "fixing" status (like compaction) once.
                            #
                            # CRITICAL: we only ever resume the outer stream loop with a
                            # LIVE 200 response. If a flatten attempt cannot obtain a 200
                            # (upstream raised/non-200), we keep trying within THIS block
                            # and never `continue` with a dead `response` (that caused the
                            # "'NoneType' object has no attribute 'aiter_bytes'" crash).
                            _resumed = False
                            if KIRO_EMPTY_FLATTEN_RECOVERY and block_offset == 0:
                                while flatten_attempts < max_flatten_retries:
                                    flatten_attempts += 1
                                    try:
                                        _flat_payload, _ = _flatten_request_for_recovery(
                                            request_data, conversation_id, profile_arn_for_payload
                                        )
                                    except Exception as _fe:
                                        logger.warning(f"Flatten recovery: build failed ({_fe}); aborting flatten")
                                        break
                                    logger.warning(
                                        f"Empty completion persisted after all retries; FLATTEN recovery "
                                        f"attempt {flatten_attempts}/{max_flatten_retries} "
                                        f"(flattening tool history, keeping tool defs)"
                                    )
                                    # Ensure message_start, then show the "fixing" status
                                    # once as its own thinking block at index 0. Recovered
                                    # content is re-indexed +1 so it never collides.
                                    if not started:
                                        started = True
                                        yield "event: message_start\ndata: " + json.dumps({"type": "message_start", "message": {"id": "msg_flatfix", "type": "message", "role": "assistant", "model": request_data.model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 0, "output_tokens": 0}}}) + "\n\n"
                                    if not flatten_status_shown:
                                        flatten_status_shown = True
                                        yield 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n'
                                        yield 'event: content_block_delta\ndata: ' + json.dumps({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "\u2699\ufe0f Fixing empty response: flattening tool-call history and retrying\u2026"}}) + "\n\n"
                                        yield 'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n'
                                    yield _PING
                                    # brief backoff between attempts (>1), heartbeat throughout
                                    if flatten_attempts > 1:
                                        _fd = min(2.0 * flatten_attempts, 8.0)
                                        _fs = 0.0
                                        while _fs < _fd:
                                            await asyncio.sleep(min(2.0, _fd - _fs))
                                            _fs += 2.0
                                            yield _PING
                                    try:
                                        await response.aclose()
                                    except Exception:
                                        pass
                                    # Obtain a fresh upstream response for the flattened
                                    # payload. request_with_retry RAISES on exhaustion, so a
                                    # failure here must NOT leave `response` as a dead handle
                                    # we later stream from.
                                    _new_resp = None
                                    try:
                                        _new_resp = await http_client.request_with_retry("POST", url, _flat_payload, stream=True)
                                    except Exception as _re:
                                        logger.warning(f"Flatten recovery: upstream request failed ({_re}); will retry if attempts remain")
                                        _new_resp = None
                                    if _new_resp is not None and getattr(_new_resp, "status_code", None) == 200:
                                        response = _new_resp
                                        flatten_recovered = True
                                        empty_attempts = max_empty_retries  # stay in recovery band
                                        _resumed = True
                                        break  # resume the OUTER loop to stream this live 200
                                    # else: no 200 -> loop to next flatten attempt (if any).
                                    # `response` is left untouched (still the previous closed
                                    # handle); we never stream from it because we either retry
                                    # here or fall through to the placeholder below.
                            if _resumed:
                                continue
                            # All flatten attempts exhausted/disabled/failed -> clean placeholder.
                            # Use index 1 when the "fixing" status already occupied index 0,
                            # so the placeholder text block never collides with it.
                            _ph_idx = block_offset + (1 if flatten_status_shown else 0)
                            if not started:
                                yield "event: message_start\ndata: " + json.dumps({"type": "message_start", "message": {"id": "msg_fallback", "type": "message", "role": "assistant", "model": request_data.model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 0, "output_tokens": 0}}}) + "\n\n"
                            yield 'event: content_block_start\ndata: ' + json.dumps({"type": "content_block_start", "index": _ph_idx, "content_block": {"type": "text", "text": ""}}) + "\n\n"
                            yield 'event: content_block_delta\ndata: ' + json.dumps({"type": "content_block_delta", "index": _ph_idx, "delta": {"type": "text_delta", "text": "(no output)"}}) + "\n\n"
                            yield 'event: content_block_stop\ndata: ' + json.dumps({"type": "content_block_stop", "index": _ph_idx}) + "\n\n"
                            yield 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n'
                            yield 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
                            logger.warning("Empty completion persisted after all retries; emitted placeholder")
                            break
                        logger.warning(f"Empty completion from Kiro; retrying upstream ({empty_attempts}/{max_empty_retries})")
                        yield _PING  # heartbeat right after an empty attempt
                        try:
                            await response.aclose()
                        except Exception:
                            pass
                        # 429-AWARE BACKOFF: an empty 200 that arrives shortly after a 429 is
                        # the upstream shedding load under throttle (proven root cause of the
                        # transip post-compaction empties during a 429 storm). Retrying fast
                        # into the same throttled window just burns the 3 empty-retries and
                        # yields '(no output)'. If a 429 was seen recently, wait much longer so
                        # the rate limit clears before we retry. Otherwise keep the short delay.
                        try:
                            from kiro.http_client import seconds_since_rate_limit
                            _since429 = seconds_since_rate_limit()
                        except Exception:
                            _since429 = 1e9
                        if _since429 < 20.0:
                            _delay = min(8.0 + 4.0 * empty_attempts, 25.0)  # 429-storm: back off hard
                            logger.info(f"Empty after recent 429 ({_since429:.1f}s ago); extended backoff {_delay}s")
                        else:
                            _delay = min(1.5 * empty_attempts, 6.0)
                        _slept = 0.0
                        while _slept < _delay:
                            await asyncio.sleep(min(2.0, _delay - _slept))
                            _slept += 2.0
                            yield _PING  # heartbeat during backoff
                        response = await http_client.request_with_retry("POST", url, active_payload, stream=True)
                        if response.status_code != 200:
                            try:
                                _err = (await response.aread()).decode("utf-8", "replace")
                            except Exception:
                                _err = "Unknown error"
                            yield f'event: error\ndata: {json.dumps({"type": "error", "error": {"type": "api_error", "message": _err[:200]}})}\n\n'
                            break
                except GeneratorExit:
                    client_disconnected = True
                    logger.debug("Client disconnected during streaming (GeneratorExit in routes)")
                except Exception as e:
                    streaming_error = e
                    # Send error event to client, then gracefully end the stream
                    try:
                        error_event = f'event: error\ndata: {json.dumps({"type": "error", "error": {"type": "api_error", "message": str(e)}})}\n\n'
                        yield error_event
                    except Exception:
                        pass
                finally:
                    await http_client.close()
                    if streaming_error:
                        error_type = type(streaming_error).__name__
                        error_msg = str(streaming_error) if str(streaming_error) else "(empty message)"
                        logger.error(f"HTTP 500 - POST /v1/messages (streaming) - [{error_type}] {error_msg[:100]}")
                    elif client_disconnected:
                        logger.info(f"HTTP 200 - POST /v1/messages (streaming) - client disconnected")
                    else:
                        logger.info(f"HTTP 200 - POST /v1/messages (streaming) - completed")
                    
                    if debug_logger:
                        if streaming_error:
                            debug_logger.flush_on_error(500, str(streaming_error))
                        else:
                            debug_logger.discard_buffers()
            
            return StreamingResponse(
                stream_wrapper(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            )
        
        else:
            # Non-streaming mode - collect entire response
            anthropic_response = await collect_anthropic_response(
                response,
                request_data.model,
                model_cache,
                auth_manager,
                request_messages=messages_for_tokenizer,
                tool_name_map=tool_name_map,
                real_input_tokens=real_input_tokens,
            )
            
            await http_client.close()
            
            logger.info(f"HTTP 200 - POST /v1/messages (non-streaming) - completed")
            
            if debug_logger:
                debug_logger.discard_buffers()
            
            return JSONResponse(content=anthropic_response)
    
    except HTTPException as e:
        await http_client.close()
        logger.error(f"HTTP {e.status_code} - POST /v1/messages - {e.detail}")
        if debug_logger:
            debug_logger.flush_on_error(e.status_code, str(e.detail))
        raise
    except Exception as e:
        await http_client.close()
        logger.error(f"Internal error: {e}", exc_info=True)
        logger.error(f"HTTP 500 - POST /v1/messages - {str(e)[:100]}")
        if debug_logger:
            debug_logger.flush_on_error(500, str(e))
        
        return JSONResponse(
            status_code=500,
            content={
                "type": "error",
                "error": {
                    "type": "api_error",
                    "message": f"Internal Server Error: {str(e)}"
                }
            }
        )


# ==================================================================================================
# /v1/messages/count_tokens — local token estimation
# ==================================================================================================
#
# Anthropic spec: https://docs.anthropic.com/en/api/messages-count-tokens
# Request body mirrors /v1/messages (without max_tokens / stream).
# Response: {"input_tokens": <int>}.
#
# Kiro has no equivalent endpoint, so we estimate locally with tiktoken
# (same approach used elsewhere in the gateway). Approximate but stable.

class _CountTokensRequest(AnthropicMessagesRequest):
    """count_tokens uses the same shape as /v1/messages but max_tokens is optional."""
    max_tokens: Optional[int] = None


@router.post("/v1/messages/count_tokens", dependencies=[Depends(verify_anthropic_api_key)])
async def count_tokens_endpoint(request_data: _CountTokensRequest):
    """
    Estimate input token count for an Anthropic Messages-style request.

    Returns:
        JSON: {"input_tokens": int}
    """
    # Reuse the same dump shape as the streaming path uses for tokenization.
    messages_for_tokenizer = [msg.model_dump() for msg in request_data.messages]
    tools_for_tokenizer = (
        [tool.model_dump() for tool in request_data.tools]
        if request_data.tools else None
    )

    # System prompt may be a string or a list of content blocks.
    system_text = ""
    if request_data.system:
        if isinstance(request_data.system, str):
            system_text = request_data.system
        elif isinstance(request_data.system, list):
            parts = []
            for block in request_data.system:
                if isinstance(block, dict):
                    parts.append(block.get("text", ""))
                else:
                    parts.append(getattr(block, "text", "") or "")
            system_text = "\n".join(p for p in parts if p)

    total = count_message_tokens(messages_for_tokenizer)
    total += count_tools_tokens(tools_for_tokenizer)
    if system_text:
        total += count_tokens(system_text)

    return JSONResponse(content={"input_tokens": int(total)})