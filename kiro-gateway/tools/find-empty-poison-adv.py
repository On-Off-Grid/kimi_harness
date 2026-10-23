#!/usr/bin/env python3
"""Advanced multi-shape empty-trigger detector + bisector.
Handles ALL content shapes: text, tool_result(str), tool_result(list of text/image),
tool_use inputs, image base64 data. Scans + optionally bisects against the gateway."""
import copy, glob, json, math, os, re, sys, urllib.request

GATEWAY = os.environ.get("KIRO_GATEWAY_URL", "http://127.0.0.1:8790") + "/v1/messages"

def entropy(s):
    if not s: return 0.0
    c={}
    for ch in s: c[ch]=c.get(ch,0)+1
    n=len(s); return -sum((v/n)*math.log2(v/n) for v in c.values())

def looks_opaque(t):
    if t.count(".")==2 and all(seg and len(seg)>=8 for seg in t.split(".")): return True
    cl=sum((any(c.isupper() for c in t),any(c.islower() for c in t),any(c.isdigit() for c in t)))
    return cl>=2 and entropy(t)>=3.5

OPAQUE=re.compile(r"[A-Za-z0-9_\-/+=.]{40,}")

def walk(messages):
    """Yield dicts describing every text/image payload with an in-place setter."""
    for i,m in enumerate(messages):
        c=m.get("content")
        if isinstance(c,str):
            yield {"i":i,"kind":"msg.str","get":(lambda m=m:m["content"]),"set":(lambda v,m=m:m.__setitem__("content",v)),"text":c}
        elif isinstance(c,list):
            for j,b in enumerate(c):
                if not isinstance(b,dict): continue
                t=b.get("type")
                if t in ("text","thinking"):
                    key="text" if t=="text" else ("thinking" if "thinking" in b else "text")
                    yield {"i":i,"kind":f"{t}","get":(lambda b=b,k=key:b.get(k,"")),"set":(lambda v,b=b,k=key:b.__setitem__(k,v)),"text":b.get(key,"")}
                elif t=="tool_use":
                    s=json.dumps(b.get("input",{}))
                    yield {"i":i,"kind":"tool_use.input","get":(lambda b=b:json.dumps(b.get("input",{}))),"set":(lambda v,b=b:b.__setitem__("input",json.loads(v))),"text":s}
                elif t=="tool_result":
                    cc=b.get("content","")
                    if isinstance(cc,str):
                        yield {"i":i,"kind":"tool_result.str","get":(lambda b=b:b.get("content","")),"set":(lambda v,b=b:b.__setitem__("content",v)),"text":cc}
                    elif isinstance(cc,list):
                        for k,bb in enumerate(cc):
                            if not isinstance(bb,dict): continue
                            if bb.get("type")=="text":
                                yield {"i":i,"kind":"tool_result.text","get":(lambda bb=bb:bb.get("text","")),"set":(lambda v,bb=bb:bb.__setitem__("text",v)),"text":bb.get("text","")}
                            elif bb.get("type")=="image":
                                src=bb.get("source",{}) or {}
                                data=src.get("data","")
                                yield {"i":i,"kind":"tool_result.image.b64","get":(lambda src=src:src.get("data","")),"set":(lambda v,src=src:src.__setitem__("data",v)),"text":data,"is_image":True,"media":src.get("media_type")}

def scan(messages):
    suspects=[]
    for node in walk(messages):
        txt=node["text"]
        if node.get("is_image"):
            # whole image data is one opaque blob
            suspects.append({"len":len(txt),"copies":1,"entropy":round(entropy(txt[:2000]),2),
                             "loc":f"msg[{node['i']}].{node['kind']}({node.get('media')})","kind":"image",
                             "risk":len(txt)*1.0,"token":txt,"node":node})
            continue
        if not txt: continue
        for mt in OPAQUE.finditer(txt):
            tok=mt.group(0)
            if not looks_opaque(tok): continue
            suspects.append({"len":len(tok),"copies":1,"entropy":round(entropy(tok),2),
                             "loc":f"msg[{node['i']}].{node['kind']}","kind":"token",
                             "risk":round(len(tok)*(entropy(tok)/6.0),1),"token":tok,"node":node})
    # merge duplicate tokens
    by_tok={}
    for s in suspects:
        if s["kind"]=="image":
            by_tok[id(s)]=s; continue
        k=s["token"]
        if k in by_tok:
            by_tok[k]["copies"]+=1; by_tok[k]["loc"]+=","+s["loc"]; by_tok[k]["risk"]+=s["risk"]
        else: by_tok[k]=s
    out=list(by_tok.values()); out.sort(key=lambda s:s["risk"],reverse=True)
    return out

def replay(data,n=3):
    body=copy.deepcopy(data); body["stream"]=False; body.setdefault("max_tokens",300)
    e=0
    for _ in range(n):
        req=urllib.request.Request(GATEWAY,data=json.dumps(body).encode(),
            headers={"content-type":"application/json","x-api-key":"dummy"})
        try:
            with urllib.request.urlopen(req,timeout=180) as r: resp=json.load(r)
        except Exception as ex:
            print(f"    replay err: {ex}",file=sys.stderr); continue
        c=resp.get("content",[]); txt="".join(b.get("text","") for b in c if isinstance(b,dict) and b.get("type")=="text")
        tc=[b for b in c if isinstance(b,dict) and b.get("type")=="tool_use"]
        if (len(txt.strip())==0 or txt.strip() in("(no output)","(empty placeholder)")) and not tc: e+=1
    return e,n

def elide_node(data, suspect_loc_kind_token, keep=12):
    """Return a deepcopy with the matching suspect elided (by re-scanning the copy)."""
    out=copy.deepcopy(data)
    target_loc, target_token, is_image = suspect_loc_kind_token
    for node in walk(out["messages"]):
        loc=f"msg[{node['i']}].{node['kind']}"+(f"({node.get('media')})" if node.get('is_image') else "")
        if node.get("is_image") and is_image and loc.split('(')[0]==target_loc.split('(')[0]:
            node["set"]("<ELIDED_IMAGE>")
        elif not node.get("is_image") and not is_image:
            cur=node["get"]()
            if isinstance(cur,str) and target_token in cur:
                node["set"](cur.replace(target_token, f"{target_token[:keep]}…<ELIDED>…{target_token[-keep:]}"))
    return out

def main():
    import argparse
    ap=argparse.ArgumentParser()
    ap.add_argument("path"); ap.add_argument("--bisect",action="store_true")
    ap.add_argument("-n",type=int,default=3); ap.add_argument("--top",type=int,default=12)
    a=ap.parse_args()
    p=a.path
    if os.path.isdir(p):
        for nm in ("request_body.json","kiro_request_body.json"):
            if os.path.isfile(os.path.join(p,nm)): p=os.path.join(p,nm); break
    data=json.load(open(p)); msgs=data["messages"]
    print(f"[loaded] {p} | {len(msgs)} messages")
    sus=scan(msgs)
    print(f"\n[suspects] {len(sus)} (text tokens + image blobs), by risk:")
    print(f"  {'risk':>10} {'len':>8} {'cp':>3} {'ent':>5}  kind  location")
    for s in sus[:a.top]:
        print(f"  {s['risk']:>10.0f} {s['len']:>8} {s['copies']:>3} {s['entropy']:>5}  {s['kind']:<6} {s['loc'][:70]}")
    if not a.bisect:
        print("\n--bisect to confirm against gateway."); return 0
    print(f"\n[bisect] {GATEWAY} ({a.n}x)")
    be,bn=replay(data,a.n); print(f"  baseline: {be}/{bn} empty")
    if be==0:
        print("  baseline not empty (gateway already eliding text tokens; images pass through)."); 
    # Test eliding ALL images together, then each top token
    imgs=[s for s in sus if s["kind"]=="image"]
    if imgs:
        v=copy.deepcopy(data)
        for node in walk(v["messages"]):
            if node.get("is_image"): node["set"]("<ELIDED_IMAGE>")
        e,n=replay(v,a.n); print(f"  elide ALL {len(imgs)} image blob(s): {e}/{n} empty"+("  <<< IMAGES are the trigger" if e<be else ""))
    for s in sus[:a.top]:
        if s["kind"]=="image":
            v=elide_node(data,(s["loc"],s["token"],True))
        else:
            v=elide_node(data,(s["loc"],s["token"],False))
        e,n=replay(v,a.n)
        tag="  <<< POISON" if e==0 and be>0 else ("  (reduces)" if e<be else "")
        print(f"  elide {s['kind']} len={s['len']} @ {s['loc'][:40]}: {e}/{n}{tag}")
    return 0

if __name__=="__main__": sys.exit(main())
