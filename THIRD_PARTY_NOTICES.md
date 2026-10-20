# Origin

DSH in Codex derives from [Pi in Codex](https://github.com/more-nico/pi-in-codex)
at commit `1d78d8a`, MIT, Copyright (c) 2026 pi_in_codex contributors.
The original copyright and full MIT text are retained in LICENSE. The React
panel, MCP contracts, scheduling, persistence, hooks, installation and tests
are adapted from that project. The DSH bridge is new integration code.

DeepSeek Harness is a separately installed MIT-licensed runtime, Copyright
DeepSeek and contributors. It is not bundled into this distribution.
See https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE .

## DeepSeek 鲸鱼娘 / DeepSeek whale-girl logo

`assets/whale-girl.png` is the original transparent DeepSeek 鲸鱼娘 pixel
portrait from [ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI),
commit `5e0146bc8d25f8b105860a766a72d48eda385177`,
`assets/whale-girl/whale-girl.png`. The upstream describes it as an
author-designed 464 × 464 pixel portrait. Copyright (c) 2026 chimney
(ccch1mneyyy), MIT. The complete upstream license is preserved in
`assets/whale-girl-LICENSE.txt`, with pinned source and SHA-256 in
`assets/whale-girl-source.json`.

The PNG is byte-identical to upstream. `assets/icon.svg` and
`assets/dsh-in-codex.svg` embed it unchanged in a new composition. The
lowercase pixel lettering is adapted to “in” from Pi in Codex; its purple
terminal is retained. The historical attribution below remains as a record
of the source project. This is an unofficial community depiction of DeepSeek
鲸鱼娘, not an official product endorsement. Product names and trademarks
remain with their respective owners.

# Third-party notices

The activity-name mapping in `src/manager.ts` and compact token formatting in
`web/format.ts` are adapted from `src/ui/agent-widget.ts` in
[tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).
Its terminal renderer and orchestration runtime are not included.

MIT License

Copyright (c) 2026 tintinweb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The build also bundles the dependencies declared in package-lock.json. Their
license notices are collected in dist/DEPENDENCY_NOTICES.txt by the build script.
Pi is not a runtime dependency of DSH in Codex.

## Historical artwork in upstream Pi in Codex

The following notices describe the source project's historical artwork.
The current DSH logo and icon use the whale-girl composition credited above.

Upstream `assets/pi-in-codex.svg` used a monochrome Pi silhouette based on the
[official Pi press kit](https://pi.dev/press-kit) (`logo-auto.svg`). The Pi site
identifies its material as MIT licensed; copyright belongs to Earendil Inc.
and contributors (Copyright (c) Earendil Inc. & Contributors). The MIT
permission and warranty text printed above applies to this adaptation as well.
The lowercase n, purple pixel terminal symbol, and upstream `assets/icon.svg`
were original Pi in Codex artwork under its MIT license. The terminal symbol
is an original project symbol.

This is an independent community integration, not an official Pi or OpenAI
product. Pi and Codex names and trademarks remain the property of their owners;
the MIT copyright license does not grant trademark rights. OpenAI's
[brand guidelines](https://openai.com/brand/) prohibit incorporating its logos
into a project's own branding. Pi in Codex removed that logo in its 0.1.1
artwork. These version numbers refer to the upstream Pi project.

Earlier Pi in Codex revisions (0.1.0) used a Codex path from
[Lobe Icons](https://github.com/lobehub/lobe-icons), retrieved via
[this SVG mirror](https://asvg.app/assets/svg/codex/codex-symbol-color.svg).
Its [MIT license](https://github.com/lobehub/lobe-icons/blob/master/LICENSE)
is retained below for those revisions; it does not grant trademark permission.

Lobe Icons license (historical artwork):

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
