# burp-mcp-proxy

> **LEGACY (as of 2026-10-23):** pi's mcp-bridge now connects **directly** to the
> PortSwigger MCP extension's SSE server (`http://127.0.0.1:9876`) — the stdio
> proxy jar below is no longer used by the default runtime. Kept here for
> stdio-only clients (e.g. Claude Desktop) that cannot reach the SSE endpoint.

This bridges Burp Suite's MCP server to a stdio MCP client.

The `mcp-proxy-all.jar` is **not bundled** (third-party redistributable + size).
Get it from the MCP proxy project / your Burp AI-Agent extension, drop it here as
`mcp-proxy-all.jar`, and the installer will copy it to `~/.BurpSuite/mcp-proxy/`.
Requires the Burp app + AI-Agent extension listening on 127.0.0.1:9876.
