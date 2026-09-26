// tests/fixtures/years-board.mjs — a local-parser fixture board for
// tests/scan-years-and-titles.test.mjs. Postings with and without a stated
// years requirement, and titles that test the targets' rescue / drop rules.
// No network involved.
const job = (n, title, description) => ({ title, url: `https://jobs.example.com/${n}`, company: 'Fixture Co', location: 'Toulouse', description });
console.log(JSON.stringify([
  job(1, 'Cloud Engineer', 'Vous avez au moins 10 ans d\'expérience sur AWS.'),
  job(2, 'Data Engineer', 'Vous avez 3 ans d\'expérience en data engineering.'),
  job(3, 'DevOps Engineer', 'Rejoignez une entreprise créée il y a 30 ans.'),
  job(4, 'Lead DevOps', ''),
  job(5, 'Presales Engineer', 'Pre-sales on our cloud platform.'),
  job(6, 'Sales Manager', 'Quota-carrying role.'),
  job(7, 'Director of Cloud', 'Lead the org.'),
  job(8, 'Comptable', 'Tenue de la comptabilité.'),
]));
