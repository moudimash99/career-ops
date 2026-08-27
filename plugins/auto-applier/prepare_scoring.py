import json
import sys
from pathlib import Path
import urllib.request

repo = Path(r"C:\Users\Moudimash99\Documents\GitHub\AirBusAutoApplier")
sys.path.insert(0, str(repo))

from app import smartrecruiters
from app.record import Applications
from job_scrapper import workday_api
from app import capgemini_board
from app import employers

def fetch_workday_jd(employer_name, url):
    emp = employers.get(employer_name)
    # The external path is in the URL, usually e.g. /job/...
    # But wait, url is https://ag.wd3.myworkdayjobs.com/en-US/Airbus/job/Toulouse/XYZ
    # external_path is /job/...
    # cxs is https://ag.wd3.myworkdayjobs.com/wday/cxs/Airbus/Airbus
    external_path = "/job/" + url.split("/job/", 1)[1]
    
    req = urllib.request.Request(
        emp.workday.cxs + external_path,
        headers={"Accept": "application/json", "User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))
        html = data.get("jobPostingInfo", {}).get("jobDescription", "")
        return workday_api.html_to_text(html)

def main():
    jobs = []
    
    # 1. Gather all shortlists
    for emp_name, path in [
        ("Airbus", repo / "output" / "shortlist.json"),
        ("Accenture", repo / "output" / "accenture" / "shortlist.json"),
        ("Capgemini", repo / "output" / "capgemini" / "picks.json")
    ]:
        if path.exists():
            for j in json.loads(path.read_text("utf-8")):
                jobs.append({
                    "employer": emp_name, 
                    "title": j["title"], 
                    "url": j["url"], 
                    "age": j.get("age", 0),
                    "req_id": j.get("req_id", "")
                })

    # Sopra Steria
    print("Fetching Sopra Steria...")
    try:
        ss_jobs = list(smartrecruiters.iter_postings("SopraSteria1", "fr", max_jobs=30))
        from app.relevance import days_since_posted
        for p in ss_jobs:
            jobs.append({
                "employer": "Sopra Steria", 
                "title": p.title, 
                "url": p.url, 
                "age": days_since_posted(p.posted_on), 
                "req_id": p.req_id,
            })
    except Exception as e:
        print(f"Error fetching Sopra Steria: {e}")

    # Sort by age (lowest age is most recent)
    jobs.sort(key=lambda x: x["age"])
    top_25 = jobs[:25]
    
    # Fetch JDs for the top 25
    print("Fetching JDs...")
    results = []
    for j in top_25:
        jd = ""
        try:
            if j["employer"] == "Capgemini":
                req_id = j.get("req_id") or j["url"].split("/")[-1]
                cache = repo / "output" / "capgemini" / "jds" / f"{req_id}.txt"
                if cache.exists():
                    jd = cache.read_text("utf-8")
                else:
                    jd = capgemini_board.fetch_description(j["url"])
                    if jd:
                        cache.parent.mkdir(parents=True, exist_ok=True)
                        cache.write_text(jd, "utf-8")
            elif j["employer"] in ["Airbus", "Accenture"]:
                jd = fetch_workday_jd(j["employer"], j["url"])
            elif j["employer"] == "Sopra Steria":
                job_id = j["url"].split("/")[-1]
                req = urllib.request.Request(f"https://api.smartrecruiters.com/v1/companies/SopraSteria1/postings/{job_id}")
                with urllib.request.urlopen(req) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    jd_html = data.get("jobAd", {}).get("sections", {}).get("jobDescription", {}).get("text", "")
                    jd = workday_api.html_to_text(jd_html)
        except Exception as e:
            print(f"Error fetching JD for {j['employer']} {j['url']}: {e}")
            
        j["jd"] = jd
        results.append(j)

    (repo / "top_25_jobs.json").write_text(json.dumps(results, indent=2), "utf-8")
    print("Done writing top_25_jobs.json")

if __name__ == "__main__":
    main()
