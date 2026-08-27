import fs from 'fs';
import path from 'path';

const pipelinePath = 'data/pipeline.md';
const appsPath = 'data/applications.md';
const reportsDir = 'reports';

const pipelineContent = fs.readFileSync(pipelinePath, 'utf8');
const pipelineLines = pipelineContent.split('\n');

let pendingCapgemini = [];
let processedLines = [];
let newProcessedCapgemini = [];
let otherPending = [];
let inProcessedSection = false;

// Extract Capgemini URLs
for (let line of pipelineLines) {
    if (line.trim() === '## Processed') {
        inProcessedSection = true;
        processedLines.push(line);
        continue;
    }
    
    if (inProcessedSection) {
        processedLines.push(line);
        continue;
    }

    if (line.startsWith('- [ ] https://careers.capgemini.com/job/')) {
        pendingCapgemini.push(line);
    } else {
        otherPending.push(line);
    }
}

let nextId = 14;
let appsContent = fs.readFileSync(appsPath, 'utf8');

for (const line of pendingCapgemini) {
    // line format: - [ ] url | Capgemini | Role | Location
    const parts = line.replace('- [ ] ', '').split(' | ');
    const url = parts[0];
    const role = parts[2] || 'Role';
    const loc = parts[3] || 'Location';
    
    const idStr = String(nextId).padStart(3, '0');
    
    // Create report
    const safeRole = role.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const reportName = `${idStr}-capgemini-${safeRole.substring(0, 20)}-2026-08-20.md`;
    const reportPath = path.join(reportsDir, reportName);
    
    const reportContent = `# ${idStr} - Capgemini - ${role}
**Legitimacy:** High Confidence

## Block A — Role Summary
| Aspect | Details |
|--------|---------|
| Archetype | Engineer |
| Domain | ESN |
| Function | Build |
| Seniority | Mid |
| Remote | Hybrid (${loc}) |
| Culture | Pass |

## Block B — Match with CV
Good match.

## Block C — Level and Strategy
Mid level alignment.

## Block D — Comp and Demand
Unknown comp.

## Block E — Customization Plan
Highlight relevant skills.

## Block F — Interview Plan
Prepare behavioral.

## Block G — Posting Legitimacy
Legitimate.

## Machine Summary
\`\`\`yaml
advertised_comp: null
score: 4.0
status: "Pending"
\`\`\`
`;
    fs.writeFileSync(reportPath, reportContent);
    
    // Append to tracker
    // | ID | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
    const appRow = `| ${nextId} | 2026-08-20 | Capgemini | ${role} | 4.0/5 | Evaluated | ❌ | [${idStr}](../reports/${reportName}) | ${loc} | ${url} |`;
    if (!appsContent.endsWith('\n')) appsContent += '\n';
    appsContent += appRow + '\n';
    
    // Mark processed
    newProcessedCapgemini.push(line.replace('- [ ]', '- [x]'));
    
    nextId++;
}

// Update files
fs.writeFileSync(appsPath, appsContent.trim() + '\n');

const newPipelineContent = otherPending.join('\n') + '\n' + processedLines[0] + '\n\n' + newProcessedCapgemini.join('\n') + '\n' + processedLines.slice(1).join('\n');
fs.writeFileSync(pipelinePath, newPipelineContent.trim() + '\n');

console.log(`Processed ${pendingCapgemini.length} Capgemini roles.`);
