import subprocess, shutil, re, unicodedata
from pathlib import Path
from datetime import datetime
import PyPDF2
import re, unicodedata

def safe_filename(name: str, maxlen: int = 80) -> str:
    # Normalize accents
    name = unicodedata.normalize("NFKD", name)
    name = name.encode("ascii", "ignore").decode("ascii")
    # Replace Windows-illegal chars: <>:"/\|?* and control chars
    name = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", name)
    # Collapse spaces and dups
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"_+", "_", name).strip("._-")
    # Avoid empty/too long
    name = name[:maxlen] or "file"
    return name

def build_pdf(
    tex_path: Path,
    tex_source: str | None = None,
    engine: str = "xelatex",
    jobname: str | None = None,
    workdir: Path | None = None,
    force_rebuild: bool = True,
    clean_aux_first: bool = True,
    keep_aux: bool = False,
    quiet: bool = True,              # ← new
) -> Path:
    tex_path = Path(tex_path).resolve()
    workdir  = tex_path.parent if workdir is None else Path(workdir)
    # jobname  = (jobname or tex_path.stem).replace(" ", "_")[:60]
    jobname  = safe_filename(jobname or tex_path.stem, maxlen=80)

    # (0) write updated .tex if provided
    if tex_source is not None:
        tex_path.write_text(tex_source, encoding="utf-8")

    # (1) sanity checks
    for exe in ("latexmk", engine):
        if shutil.which(exe) is None:
            raise RuntimeError(f"{exe} not found on PATH.")

    run_opts = dict(cwd=workdir)
    if quiet:
        run_opts.update(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # (2) pre-clean
    if clean_aux_first:
        subprocess.run(["latexmk", "-C", tex_path.name], **run_opts, check=False)

    # (3) compile
    cmd = [
        "latexmk",
        f"-{engine}",
        "-halt-on-error",
        "-interaction=nonstopmode",
        "-jobname=CV",
    ]
    if force_rebuild:
        cmd.append("-g")
    if quiet:
        cmd.append("-silent")        # latexmk’s own quiet flag

    p = subprocess.run(cmd + [tex_path.name], **run_opts)

    # (4) on failure show tail of log (or captured stdout if not quiet)
    if p.returncode != 0:
        log_tail = ""
        log_file = workdir / "CV.log"
        if log_file.exists():
            tail_lines = log_file.read_text(errors="ignore").splitlines()[-80:]
            log_tail  = "\n".join(tail_lines)
        raise RuntimeError(
            f"LaTeX build failed (rc={p.returncode}).\nCommand: {' '.join(cmd)}\n\n--- LOG TAIL ---\n{log_tail}"
        )

    # (5) post-clean
    if not keep_aux:
        subprocess.run(["latexmk", "-c", tex_path.name], **run_opts, check=False)

    # (6) move PDF to timestamped name
    pdf_src = workdir / "CV.pdf"
    if not pdf_src.exists():
        raise RuntimeError("Build reported success but CV.pdf not found.")

    out_dir = workdir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamped = out_dir / f"{jobname}_{datetime.now():%Y%m%d}.pdf"
    shutil.move(str(pdf_src), stamped)
    return stamped


def pdf_is_1_page(pdf_path: Path) -> bool:
    with open(pdf_path, "rb") as f:
        return len(PyPDF2.PdfReader(f).pages) == 1

# ------------------- Example usage -------------------
if __name__ == "__main__":
    
    TEX_FILE = Path(r"C:\Users\moudi\OneDrive\Documentos\Coding\mission-control-ultra\AirBusAutoApplier\CV_Generator\Mohammad_CV_2_Parts\CV.tex")

    # Example: dynamically update a field, then compile to a timestamped PDF
    original = TEX_FILE.read_text(encoding="utf-8")
    stamped = original.replace("%%DATE_PLACEHOLDER%%", datetime.now().strftime("%Y-%m-%d"))

    out_pdf = build_pdf(
        tex_path=TEX_FILE,
        tex_source=stamped,        # omit or pass None if the .tex is already modified elsewhere
        engine="xelatex",          # match Overleaf’s engine
        jobname="mohammad_main_CV_build",  # control output filename
        force_rebuild=True,        # useful when you know content changed
        clean_aux_first=False,     # set True if latexmk thinks things are up-to-date after a failure
        keep_aux=False
    )
    print("PDF ready at:", out_pdf)
