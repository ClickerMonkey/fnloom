The rest of what the SDK exports: the pieces `serve` is built from (the manifest builder, keys, the outcome journal, the
link transport, the LLM wire, the MCP face, files and process control, client bundles). A system rarely uses these
directly; they are here so nothing is undocumented, and for tests and tools that need a seam.

The network guard is here too. Every supervised system's process (fs's hosted systems and the hub's installed
instances) gets an `AllowlistProxy` of its own for its `grants.network`, is pointed at it with `guardedEnv`, and
preloads `NETWORK_GUARD` (`--require`), the socket guard (`guardNetwork`, also `@harness/sdk/server/socket-guard`) that
holds every socket to the proxy and the hub. A refused host prints a `networkRefusedLine`, which the supervisor reads
back (`refusedOfLine`) and reports to the hub; `setAllowed` changes what a running proxy lets through.
