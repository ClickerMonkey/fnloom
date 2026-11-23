/**
 * The Ollama system's server: its implementation (`impl.ts`) and the process that serves it (`main.ts`). Each outside
 * part is an interface, so `createOllamaImpl` takes the real ones in `main.ts` and fakes in tests: the server's HTTP API
 * (`api.ts`), the release source, download and unpack (`install.ts`), and the child process (`serve.ts`).
 */
export { ollama, type OllamaContract } from '../shared/index.ts';
export { HttpOllamaApi, type OllamaApiFactory, type OllamaServerApi } from './api.ts';
export { createOllamaImpl, type OllamaDeps, type OllamaServer, type PublishModels } from './impl.ts';
export { FetchDownloader, GitHubReleases, Installer, TarExtractor, type Downloader, type Extractor, type Release, type ReleaseSource } from './install.ts';
export { NodeChildRunner, OllamaProcess, type ChildHandle, type ChildRunner } from './serve.ts';
