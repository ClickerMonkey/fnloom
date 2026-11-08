The rest of what the SDK exports: the pieces `serve` is built from (the manifest builder, keys, the outcome journal, the
link transport, the LLM wire, the MCP face, files and process control, client bundles). A system rarely uses these
directly; they are here so nothing is undocumented, and for tests and tools that need a seam.
