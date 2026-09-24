# python/ — optional helper layer (honest status)

AI-EXECUTIVE is engineered to run **without Python**. Everything the system
claims to do is implemented in the Node/TypeScript backend plus the renderer:

| Capability | Implementation | Requires Python? |
|---|---|---|
| Research (real URLs) | `src/lib/tools/knowledgeTools.ts` (Wikipedia REST, OpenAlex, Hacker News) | no |
| Document extraction (PDF/DOCX/XLSX/CSV/TXT) | `unpdf`, `mammoth`, `fflate` OOXML reader | no |
| Filesystem work | `src/lib/tools/fsTools.ts` | no |
| Shell execution (approval gated) | `src/lib/tools/systemTools.ts` | no |
| Video pipeline (frames → MP4 → ffprobe) | `src/lib/tools/mediaTools.ts` + `ffmpeg-static`/`ffprobe-static` | no |
| 3D office | React Three Fiber (`src/components/office/Office3D.tsx`) | no |
| Windows accessibility control (`pywinauto`), global hotkeys (`pynput`), OCR (`pytesseract`) | NOT implemented here | yes — optional |

## Status of this directory

There is **no Python code in this directory on purpose**. A stub script that
silently returned fake data would violate the anti-mock rule of this project, so
the optional Python layer is documented instead of pretended.

If you want the Python-powered desktop-control layer on Windows:

1. `python -m venv .venv`
2. `.venv\Scripts\activate`
3. `pip install -r requirements.txt` (uncomment the packages you actually want)
4. The Computer Agent will then report those capabilities as AVAILABLE in the
   Doctor and will route screenshots/OCR/window control through them.

Until then the Doctor reports them as `UNAVAILABLE` and the agents say so out
loud rather than simulating a click.
