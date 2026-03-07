Run ruff check .
F401 [*] `google.genai` imported but unused
 --> image_gen.py:5:20
  |
3 | import base64
4 | from typing import Optional
5 | from google import genai
  |                    ^^^^^
6 | from google.genai import types
  |
help: Remove unused import: `google.genai`

F401 [*] `os` imported but unused
 --> main.py:1:8
  |
1 | import os
  |        ^^
2 | import re
3 | import uuid
  |
help: Remove unused import: `os`

F401 [*] `os` imported but unused
 --> processor.py:2:8
  |
1 | import io
2 | import os
  |        ^^
3 | import logging
4 | from pypdf import PdfReader
  |
help: Remove unused import: `os`

Found 3 errors.
[*] 3 fixable with the `--fix` option.


frontend:
Run npm run build

> my-app@0.1.0 build
> next build

⚠ Warning: Next.js inferred your workspace root, but it may not be correct.
 We detected multiple lockfiles and selected the directory of /home/runner/work/enpitsu/enpitsu/package-lock.json as the root directory.
 To silence this warning, set `turbopack.root` in your Next.js config, or consider removing one of the lockfiles if it's not needed.
   See https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory for more information.
 Detected additional lockfiles: 
   * /home/runner/work/enpitsu/enpitsu/frontend/package-lock.json

⚠ No build cache found. Please configure build caching for faster rebuilds. Read more: https://nextjs.org/docs/messages/no-cache
Attention: Next.js now collects completely anonymous telemetry regarding usage.
This information is used to shape Next.js' roadmap and prioritize features.
You can learn more, including how to opt-out if you'd not like to participate in this anonymous program, by visiting the following URL:
https://nextjs.org/telemetry

▲ Next.js 16.1.6 (Turbopack)

  Creating an optimized production build ...
✓ Compiled successfully in 7.4s
  Running TypeScript ...
  Collecting page data using 3 workers ...
  Generating static pages using 3 workers (0/8) ...
  Generating static pages using 3 workers (2/8) 
Error occurred prerendering page "/_not-found". Read more: https://nextjs.org/docs/messages/prerender-error
Error [FirebaseError]: Firebase: Error (auth/invalid-api-key).
    at p (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:15:24223)
    at q (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:15:24271)
    at aa.instanceFactory (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:15:75756)
    at ac.getOrInitializeService (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:1:13345)
    at ac.initialize (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:1:12753)
    at aJ (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:15:62116)
    at bs (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:15:76488)
    at module evaluation (.next/server/chunks/ssr/[root-of-the-server]__263a1dbe._.js:15:81165)
    at instantiateModule (.next/server/chunks/ssr/[turbopack]_runtime.js:740:9)
    at getOrInstantiateModuleFromParent (.next/server/chunks/ssr/[turbopack]_runtime.js:763:12) {
  code: 'auth/invalid-api-key',
  customData: [Object],
  digest: '1234325985'
}
Export encountered an error on /_not-found/page: /_not-found, exiting the build.
⨯ Next.js build worker exited with code: 1 and signal: null
Error: Process completed with exit code 1.