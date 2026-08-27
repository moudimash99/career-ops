// build-capgemini-cvs.mjs — four tailored French CVs from one set of facts
// ---------------------------------------------------------------------------
// Capgemini's Toulouse/Blagnac postings split into four role families. Rather
// than 15 near-identical PDFs, we build one CV per family.
//
// Every variant draws from the SAME base payload (cv-payload.json, itself
// derived from cv.md). Variants may reorder, reweight and re-emphasise —
// summary wording, competency order, skill-group order — but never introduce
// a claim the base payload does not already make. Bullets are copied verbatim.
//
// Usage: node scripts/build-capgemini-cvs.mjs [--only cloud,data]
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = path.resolve(import.meta.dirname, "..");
const base = JSON.parse(fs.readFileSync(path.join(root, "cv-payload.json"), "utf8"));
const outDir = path.join(root, "output");
const scratch = path.join(root, "scratch");
const today = new Date().toISOString().slice(0, 10);

// Order experience/skills by company/category name, keeping entries intact.
const orderBy = (list, key, order) =>
  [...list].sort((a, b) => {
    const ia = order.findIndex((o) => a[key].startsWith(o));
    const ib = order.findIndex((o) => b[key].startsWith(o));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

const VARIANTS = {
  cloud: {
    slug: "cloud",
    // The base payload is already Cloud/DevOps-weighted — used as-is.
    summary: base.summary,
    competencies: [
      "AWS & Kubernetes",
      "Automatisation & IaC",
      "Administration Systèmes Linux",
      "Exploitation Niveaux 2/3",
      "Observabilité",
      "Ingénierie Système (MBSE)",
    ],
    experienceOrder: ["Green Praxis", "Airbus Electric Center", "Airbus SAS", "Murex"],
    skillsOrder: ["Systèmes & Cloud", "Développement & Données", "Ingénierie Système"],
  },

  systems: {
    slug: "systemes",
    summary:
      "Ingénieur systèmes diplômé du Mastère Spécialisé Systems Engineering de l'ISAE-SUPAERO (MBSE, SysML/Capella, ISO/IEC 15288) et certifié INCOSE ASEP, avec une expérience opérationnelle en environnement aéronautique et spatial chez Airbus. Je modélise des architectures système, rédige exigences et ICDs, et définis les stratégies de vérification et validation, en m'appuyant sur une pratique concrète de l'exploitation de plateformes temps réel à SLA strict.",
    competencies: [
      "Ingénierie Système (MBSE)",
      "Exigences & ICDs",
      "Vérification & Validation",
      "SysML / Capella",
      "Architecture de Données",
      "Environnement Aéronautique & Spatial",
    ],
    experienceOrder: ["Airbus Electric Center", "Airbus SAS", "Green Praxis", "Murex"],
    skillsOrder: ["Ingénierie Système", "Systèmes & Cloud", "Développement & Données"],
  },

  data: {
    slug: "data",
    summary:
      "Ingénieur données avec une expérience éprouvée en conception de pipelines d'ingestion et de traitement à grande échelle : plus de 15 DAGs Airflow pour l'ingestion géospatiale (débit multiplié par 6), flux ETL Python consolidant des sources hétérogènes sur 5 régions chez Airbus, et architecture de données qualité sur Skywise (Palantir Foundry). Formation en ingénierie système (ISAE-SUPAERO MS SEN) appliquée à la garantie d'intégrité des données.",
    competencies: [
      "Pipelines de Données & ETL",
      "Airflow & Orchestration",
      "Données Géospatiales",
      "Palantir Foundry / Skywise",
      "AWS & Kubernetes",
      "Qualité & Intégrité des Données",
    ],
    experienceOrder: ["Green Praxis", "Airbus SAS", "Airbus Electric Center", "Murex"],
    skillsOrder: ["Développement & Données", "Systèmes & Cloud", "Ingénierie Système"],
  },

  fullstack: {
    slug: "fullstack",
    summary:
      "Développeur et architecte logiciel avec une expérience en conception d'APIs et de composants modulaires : refonte d'un service statique vers une API FastAPI à la demande avec cache Redis (latence P95 réduite de 63%), architecture d'une plateforme d'analyse de logs chez Murex Systems, et pipelines de déploiement automatisés sur Kubernetes et Docker. Solide culture systèmes et cloud, complétée par une formation en ingénierie système (ISAE-SUPAERO MS SEN).",
    competencies: [
      "Développement Backend & APIs",
      "Python / FastAPI",
      "C++ & Programmation Système",
      "Architecture Logicielle",
      "Docker & Kubernetes",
      "CI/CD",
    ],
    experienceOrder: ["Murex", "Green Praxis", "Airbus SAS", "Airbus Electric Center"],
    skillsOrder: ["Développement & Données", "Systèmes & Cloud", "Ingénierie Système"],
  },
};

const onlyArg = process.argv.indexOf("--only");
const selected =
  onlyArg > -1 ? process.argv[onlyArg + 1].split(",") : Object.keys(VARIANTS);

fs.mkdirSync(scratch, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const template = execFileSync("node", ["cv-templates.mjs", "resolve", "cv"], {
  cwd: root,
  encoding: "utf8",
}).trim();

const results = [];

for (const name of selected) {
  const v = VARIANTS[name];
  if (!v) {
    console.error(`✗ unknown variant "${name}"`);
    process.exitCode = 1;
    continue;
  }

  const payload = {
    ...base,
    summary: v.summary,
    competencies: v.competencies,
    experience: orderBy(base.experience, "company", v.experienceOrder),
    skills: orderBy(base.skills, "category", v.skillsOrder),
  };

  const stem = `cv-mohammad-machaka-capgemini-${v.slug}-fr`;
  const jsonPath = path.join(scratch, `${stem}.json`);
  const htmlPath = path.join(outDir, `${stem}.html`);
  const pdfPath = path.join(outDir, `${stem}.pdf`);

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

  const run = (args) =>
    execFileSync("node", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

  try {
    run(["build-cv-html.mjs", jsonPath, htmlPath, template]);
    run(["verify-cv-facts.mjs", htmlPath]); // hard gate — no unsourced claims
    run(["generate-pdf.mjs", htmlPath, pdfPath, "--format=a4"]);
    console.log(`✅ ${name.padEnd(9)} → ${path.relative(root, pdfPath)}`);
    results.push({ name, pdf: pdfPath });
  } catch (err) {
    const detail = (err.stdout || "") + (err.stderr || "") || err.message;
    console.error(`❌ ${name} failed:\n${detail.trim()}`);
    process.exitCode = 1;
  }
}

console.log(`\n${results.length}/${selected.length} CV variant(s) built (${today}).`);
