import json
jobs = json.load(open('top_25_jobs.json', 'r', encoding='utf-8'))
for i, j in enumerate(jobs):
    print(f"{i}. {j['title']} | {j['employer']} | {j.get('location', 'Toulouse')} | Age: {j['age']} | {j['url']}")
