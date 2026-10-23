# burp-mcp-proxy

This bridges Burp Suite's MCP server to a stdio MCP client.

The `mcp-proxy-all.jar` is **not bundled** (third-party redistributable + size).
Get it from the MCP proxy project / your Burp AI-Agent extension, drop it here as
`mcp-proxy-all.jar`, and the installer will copy it to `~/.BurpSuite/mcp-proxy/`.
Requires the Burp app + AI-Agent extension listening on 127.0.0.1:9876.
