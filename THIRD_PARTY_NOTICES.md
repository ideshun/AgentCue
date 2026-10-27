# Third-party notices

AgentCue's original source code is distributed under the [MIT License](LICENSE).
Third-party libraries, fonts, and product marks retain their respective licenses and ownership.

| Component | Upstream / license |
| --- | --- |
| Electron | https://github.com/electron/electron — MIT; Chromium notices are shipped separately |
| sherpa-onnx | https://github.com/k2-fsa/sherpa-onnx — Apache-2.0 |
| ONNX Runtime | https://github.com/microsoft/onnxruntime — MIT |
| better-sqlite3 | https://github.com/WiseLibs/better-sqlite3 — MIT; SQLite is public domain |
| Inter | [Bundled font license](apps/desktop/src/renderer/fonts/Inter-LICENSE.txt) — SIL Open Font License |
| JetBrains Mono | [Bundled font license](apps/desktop/src/renderer/fonts/JetBrainsMono-LICENSE.txt) — SIL Open Font License |

Dependency license files and package metadata accompany the application. The packaged
`Resources/licenses/` (Windows/Linux: `resources/licenses/`) directory contains the project license,
Electron license, the Apache-2.0 license, and the complete Chromium license list in
`Chromium-LICENSES.html.gz`. Decompress that file to read the original HTML; compression does not
remove or alter any notice.

The office uses product icons to identify the monitored tools. Those icons remain the property
of their respective owners and do not imply sponsorship or endorsement. Sources and asset history
are documented in [the office asset notes](apps/desktop/src/renderer/assets/office/README.md).

AI-generated desk illustrations and their previous versions are preserved in this repository.
Only the versions referenced by the current office renderer are copied into installation packages.
Speech models are not included in the installer; consult each model's license at its download source.
