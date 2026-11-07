# Third-Party Notices

This repository includes third-party software and font assets. Those components
remain subject to their own copyright and license terms; the repository’s AGPL
license does not replace them.

| Component / path | Upstream | Copyright | License | Local modifications |
|---|---|---|---|---|
| `frontend/public/pdfjs/**` | [Mozilla PDF.js / pdfjs-dist 3.11.174](https://github.com/mozilla/pdf.js) | Mozilla and PDF.js contributors; additional notices in the tree | Apache-2.0, with component-specific notices | Packaged runtime distribution and integration configuration |
| `frontend/public/pdfjs/cmaps/**` | Included with PDF.js | Adobe Systems Incorporated and contributors | BSD-style terms in `cmaps/LICENSE` | No license change |
| `frontend/public/pdfjs/standard_fonts/**` | Included with PDF.js | PDFium authors, Google, Red Hat, and identified contributors | BSD-3-Clause for Foxit fonts (`LICENSE_FOXIT`); OFL-1.1 for Liberation fonts (`LICENSE_LIBERATION`) | No license change |
| `frontend/public/fonts/rare-han/**` | [Source Han Sans](https://github.com/adobe-fonts/source-han-sans) and [Plangothic](https://github.com/Fitzgerald-Porthmouth-Koenigsegg/Plangothic_Project) | Adobe and Fitzgerald P. Köenigsegg; see path notices | OFL-1.1 | Renamed, unhinted WOFF2 subsets; reproducible build and hashes documented in the path README |
| `frontend/public/fonts/phonetic/**` | [SIL Charis](https://software.sil.org/charis/) and Source Han Sans | SIL International, Adobe, and identified contributors | OFL-1.1 | Renamed/subset WOFF2 assets; provenance documented in the path README and manifests |

The authoritative notices are the license and README files stored beside each
component. Preserve them when updating or redistributing the assets.

The backend runtime image also installs [Poppler](https://poppler.freedesktop.org/)
(`poppler-utils`, GPL-2.0-or-later) and [libwebp](https://chromium.googlesource.com/webm/libwebp/)
(`libwebp-tools`, BSD-3-Clause) from Alpine packages for private PDF page previews.
They are unmodified external command-line programs; their package licenses and
corresponding sources remain available through the Alpine package repositories.
Generated page images retain the rights and access restrictions of their source
documents, as described in `ASSET_BOUNDARIES.md`.


## Optional local OCR worker

`backend/ocr-worker.Dockerfile` adds the following feature-specific components
through signed Alpine 3.24 packages. Exact package versions and model SHA256s
are recorded for the tested image in `docs/evidence/issue-122-310`; a later image
build must retain its own package manifest. These are unmodified command-line
programs/models; the application only orchestrates them.

| Component / distributed path | Source and version | Copyright | License / retained notice |
|---|---|---|---|
| Tesseract (`/usr/bin/tesseract`, `libtesseract`) | [Tesseract 5.5.2](https://github.com/tesseract-ocr/tesseract/tree/5.5.2), Alpine `tesseract-ocr` 5.5.2-r0 at verification | Tesseract contributors; see upstream source notices | Apache-2.0; `backend/ocrengine/licenses/TESSERACT-LICENSE.txt` copied to `/usr/share/licenses/wanyu-ocr/` |
| eng and chi_sim `.traineddata` | [tessdata 4.1.0](https://github.com/tesseract-ocr/tessdata/tree/4.1.0), packaged by Alpine as `tesseract-ocr-data-eng` / `tesseract-ocr-data-chi_sim`; model source is identified independently of the engine package version | Tesseract tessdata contributors; upstream repository notices | [Apache-2.0 model license](https://github.com/tesseract-ocr/tessdata/blob/4.1.0/LICENSE); `backend/ocrengine/licenses/TESSDATA-LICENSE.txt` copied beside the engine notice |
| Poppler / `poppler-utils` | [Poppler](https://poppler.freedesktop.org/), Alpine 3.24 package, exact build version in the image manifest | Poppler contributors | GPL-2.0-or-later; same external executable/source distribution boundary as the existing backend Poppler entry above |

The official [Alpine APKBUILD](https://github.com/alpinelinux/aports/blob/3.24-stable/community/tesseract-ocr/APKBUILD)
explicitly selects Tesseract 5.5.2 and tessdata 4.1.0. This model registration is
based on the model repository license, rather than inferred from the engine
license. Preserve both the corresponding upstream sources and applicable
notices when redistributing an image; Alpine package metadata does not replace
release-time fulfillment of source/notice obligations. No external recognition
service is used, and neither the software license nor model license grants
rights to an uploaded document or its extracted text.
