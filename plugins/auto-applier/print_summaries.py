import json
import re
import sys
from pathlib import Path

jobs = json.load(open('top_25_jobs.json', 'r', encoding='utf-8'))
out = []
for i, j in enumerate(jobs):
    out.append(f"### [{i}] {j['employer']} - {j['title']}")
    out.append(f"**URL**: {j['url']}")
    
    jd = j.get('jd', '')
    # Just grab the last 1500 chars as well as requirements
    match = re.search(r"(profil|comp[eé]tences|requirements|required|qui \u00eates-vous|vous \u00eates).*", jd, re.I | re.S)
    if match:
        reqs = match.group(0)[:1500]
    else:
        reqs = jd[-1500:] if len(jd) > 1500 else jd
        
    out.append(f"**Reqs**:\n```\n{reqs.strip()}\n```\n")

Path("jobs_summary.md").write_text("\n".join(out), "utf-8")
print("Wrote jobs_summary.md")
