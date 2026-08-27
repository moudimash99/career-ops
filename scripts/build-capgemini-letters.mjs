// build-capgemini-letters.mjs — per-role French cover letters for Capgemini
// ---------------------------------------------------------------------------
// One letter per role, written against that posting's actual requirements.
// Every figure and tool named here is traceable to cv.md; nothing the JD asks
// for but the CV does not evidence is claimed (notably: no Ansible, no GitLab
// CI, no Azure depth, no TOGAF, no Lambda/RDS/DynamoDB experience).
//
// Usage: node scripts/build-capgemini-letters.mjs [--only 4,5]
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const root = path.resolve(import.meta.dirname, "..");
const scratch = path.join(root, "scratch");
const today = new Date().toISOString().slice(0, 10);

const CANDIDATE = {
  name: "Mohammad Machaka",
  email: "machaka.mohammad@gmail.com",
  phone: "+33 7 53 37 78 23",
  location: "Toulouse, France",
  linkedin: "https://linkedin.com/in/mohammad-machaka-a63685172",
  credentials: [
    "MS Ingénierie des Systèmes, ISAE-SUPAERO",
    "ASEP (INCOSE)",
    "AWS Solutions Architect – Associate",
  ],
};

const GREETING = "Madame, Monsieur,";
const CLOSING =
  "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.";

// Shared closing paragraph — availability is factual, the permit is not raised
// here (per the agreed strategy it only comes up once a figure is on the table).
const AVAILABILITY =
  "Je suis installé à Toulouse et disponible dès à présent ; mon stage de fin d'études " +
  "chez Airbus Electric Center s'achève le 18 novembre 2026. Je serais heureux d'échanger " +
  "sur vos projets et de vous exposer ma démarche plus en détail.";

const LETTERS = {
  1: {
    slug: "lead-engineer-cloud-aws",
    role_title: "Lead Engineer Cloud AWS (réf. 396891)",
    city: "Toulouse",
    opening:
      "Votre annonce précise que le poste requiert une certification AWS DevOps Engineer, " +
      "Developer ou Solutions Architect. Je suis titulaire de la certification AWS Certified " +
      "Solutions Architect – Associate (SAA-C03), et c'est en la mettant en pratique " +
      "quotidiennement que j'ai construit mon parcours d'ingénieur cloud.",
    profile_intro:
      "Chez Green Praxis, j'ai été responsable de bout en bout de la plateforme AWS qui " +
      "transforme de l'imagerie satellite en tuiles cartographiques à la demande et en " +
      "indicateurs environnementaux : provisionnement des nœuds EKS avec Terraform et " +
      "Karpenter, déploiement par Helm, et industrialisation de la chaîne CI/CD sous " +
      "GitHub Actions.",
    achievements: [
      {
        lead: "Ré-architecture d'un service de tuiles statiques en passerelle FastAPI à la demande",
        impact: "empreinte de stockage réduite de 80% et latence P95 ramenée de 600 ms à 220 ms.",
      },
      {
        lead: "Supervision Prometheus et Grafana déployée via Helm",
        impact: "24 tableaux de bord et 35 règles d'alerte, pour un SLA de pipeline supérieur à 98%.",
      },
      {
        lead: "Encadrement technique chez Murex Systems",
        impact:
          "pilotage d'une plateforme d'analyse de logs et mentorat d'une équipe de trois " +
          "personnes, avec instauration des revues de code, des tests et de l'intégration continue.",
      },
    ],
    problems_section:
      "Je viens d'achever le Mastère Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO " +
      "et je suis certifié ASEP (INCOSE). Cette formation change ma façon d'aborder une " +
      "plateforme : exigences explicites, interfaces spécifiées, compromis argumentés et " +
      "stratégie de vérification définie avant de coder. Dans un contexte de conseil où il " +
      "faut traduire le besoin d'un client en architecture défendable, c'est un atout concret.",
  },

  4: {
    slug: "architecte-cloud-aws",
    role_title: "Architecte Cloud – Amazon Web Services (réf. 332039)",
    city: "Toulouse",
    opening:
      "Concevoir des architectures AWS sécurisées et scalables, promouvoir l'Infrastructure " +
      "as Code et les pipelines CI/CD : c'est précisément le travail que j'ai mené ces " +
      "dernières années, et que la certification AWS Solutions Architect – Associate " +
      "(SAA-C03) est venue formaliser.",
    profile_intro:
      "Chez Green Praxis, j'ai conçu et exploité l'architecture AWS d'une plateforme " +
      "géospatiale de production : VPC, EKS, buckets S3 versionnés et IAM au moindre " +
      "privilège, le tout décrit dans des modules Terraform réutilisables et déployé par " +
      "Helm et GitHub Actions.",
    achievements: [
      {
        lead: "Patterns cloud-native appliqués à un service en production",
        impact:
          "nœuds EKS provisionnés par Terraform et Karpenter pour un autoscaling dynamique, " +
          "avec une passerelle FastAPI et un cache Redis à la place d'un service statique.",
      },
      {
        lead: "Résultats mesurés de cette architecture",
        impact:
          "stockage réduit de 80%, latence P95 de 600 ms à 220 ms, et SLA de pipeline " +
          "maintenu au-dessus de 98% grâce à 35 règles d'alerte.",
      },
      {
        lead: "Architecture de flux de données chez Airbus",
        impact:
          "définition des interfaces et des contrats du projet OPTIMATE, et flux ETL " +
          "unifiés consolidant des sources hétérogènes sur cinq régions.",
      },
    ],
    problems_section:
      "Le volet « vulgarisation » de l'annonce rejoint ce que m'a apporté le Mastère " +
      "Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO (certifié ASEP INCOSE) : " +
      "formaliser les exigences, spécifier les interfaces et documenter les compromis " +
      "d'architecture avant de construire. C'est ce qui rend une cible défendable devant " +
      "un client comme devant une équipe.",
  },

  5: {
    slug: "tech-lead-devops",
    role_title: "Tech Lead DevOps (réf. 333938)",
    city: "Toulouse",
    opening:
      "Votre annonce demande une certification DevOps Engineer, Developer ou Solutions " +
      "Architect chez un grand fournisseur cloud : je suis titulaire de l'AWS Certified " +
      "Solutions Architect – Associate (SAA-C03). Elle demande aussi un goût prononcé pour " +
      "le mentorat, et c'est la partie du poste qui m'attire le plus.",
    profile_intro:
      "Chez Murex Systems, j'ai conçu et piloté une plateforme d'analyse de logs, encadré " +
      "une équipe de trois personnes et instauré les revues de code, les tests et " +
      "l'intégration continue. Ce travail a permis d'identifier plus de cinquante types " +
      "d'erreurs jusque-là non détectés.",
    achievements: [
      {
        lead: "Chaîne d'automatisation complète chez Green Praxis",
        impact:
          "Docker, Kubernetes et Helm sur AWS EKS, infrastructure décrite en Terraform, " +
          "CI/CD sous GitHub Actions — lint, tests, build, push et déploiement.",
      },
      {
        lead: "Exploitation de niveaux 2 et 3 sur des plateformes Linux",
        impact:
          "supervision Prometheus et Grafana couvrant 95% des chemins critiques, SLA " +
          "de pipeline supérieur à 98%.",
      },
      {
        lead: "Automatisation orientée résultat",
        impact:
          "plus de 15 DAGs Airflow pour l'ingestion géospatiale, portant le débit de 8 à " +
          "48 scènes par heure, et latence P95 de l'API réduite de 63%.",
      },
    ],
    problems_section:
      "Je serai transparent sur un point : vous demandez au moins six ans d'expérience en " +
      "environnement DevOps, et j'en totalise environ cinq, dont huit mois d'encadrement " +
      "direct. Ce que j'apporte en regard, c'est une pratique complète de la chaîne " +
      "d'automatisation sur des plateformes en production, et le Mastère Spécialisé en " +
      "Ingénierie des Systèmes de l'ISAE-SUPAERO (certifié ASEP INCOSE), qui structure ma " +
      "façon de spécifier et de vérifier avant de livrer.",
  },

  15: {
    slug: "architecte-cloud-azure",
    role_title: "Architecte Cloud Azure (réf. 396925)",
    city: "Toulouse",
    opening:
      "Votre programme de migration et de modernisation de plusieurs centaines " +
      "d'applications vers le cloud est exactement le type de problème que j'aime traiter : " +
      "analyser l'existant, définir une cible d'architecture et la conduire jusqu'en " +
      "production, sous contrainte de performance, de sécurité et de coût.",
    profile_intro:
      "Mon expérience d'architecture cloud s'est construite sur AWS, où j'ai conçu et " +
      "exploité de bout en bout la plateforme de Green Praxis : réseau, IAM au moindre " +
      "privilège, EKS provisionné par Terraform et Karpenter, et supervision complète. " +
      "Azure fait partie de mon environnement technique, et la certification est au " +
      "programme de ma montée en compétence.",
    achievements: [
      {
        lead: "Une migration menée de l'analyse de l'existant à la cible",
        impact:
          "remplacement d'un service de tuiles statiques par une architecture à la demande, " +
          "avec un stockage réduit de 80% et une latence P95 ramenée de 600 ms à 220 ms.",
      },
      {
        lead: "Gouvernance et résilience traitées comme des exigences, pas des options",
        impact:
          "IAM au moindre privilège, buckets versionnés, 35 règles d'alerte et un SLA de " +
          "pipeline maintenu au-dessus de 98%.",
      },
      {
        lead: "Accompagnement d'équipe",
        impact:
          "mentorat d'une équipe de trois personnes chez Murex Systems, avec mise en place " +
          "des revues de code, des tests et de l'intégration continue.",
      },
    ],
    problems_section:
      "Sur les frameworks d'architecture, je viens du Mastère Spécialisé en Ingénierie des " +
      "Systèmes de l'ISAE-SUPAERO et suis certifié ASEP (INCOSE) : ISO/IEC 15288, ingénierie " +
      "des exigences, spécification d'interfaces et stratégie de vérification. Ce n'est pas " +
      "TOGAF, mais c'est la même discipline appliquée à la conception de systèmes complexes, " +
      "et elle se transpose directement à une cible d'architecture applicative.",
  },
  // --- Remaining shortlist -------------------------------------------------
  // Written to lead with strengths. Where a JD names a tool or credential the
  // CV does not evidence (Ansible, Openshift, Azure certification, Spring,
  // PLM suites, power electronics), the letter neither claims it nor draws
  // attention to it — it argues from what is actually documented.

  17: {
    slug: "lead-engineer-cloud-azure",
    role_title: "Lead Engineer Cloud Azure (réf. 396925)",
    city: "Toulouse",
    opening:
      "Garantir la cohérence technique d'une plateforme, porter les POC et faire monter " +
      "une équipe en compétence : c'est le rôle que je cherche, et la trajectoire que j'ai " +
      "suivie entre l'ingénierie de plateformes cloud et l'ingénierie de données.",
    profile_intro:
      "Chez Green Praxis, j'ai porté seul l'architecture et l'exploitation d'une plateforme " +
      "cloud de production, du réseau et de l'IAM jusqu'à la supervision. Côté données, " +
      "j'ai construit plus de 15 DAGs Airflow d'ingestion géospatiale et, chez Airbus, des " +
      "flux ETL unifiant des sources hétérogènes sur cinq régions.",
    achievements: [
      {
        lead: "Plateforme managée de bout en bout",
        impact:
          "EKS provisionné par Terraform et Karpenter, déploiements Helm, CI/CD GitHub " +
          "Actions, et une passerelle FastAPI qui a réduit le stockage de 80%.",
      },
      {
        lead: "Démarche FinOps et supervision appliquées concrètement",
        impact:
          "autoscaling dynamique pour ajuster la capacité à la charge, 35 règles d'alerte " +
          "et un SLA de pipeline maintenu au-dessus de 98%.",
      },
      {
        lead: "Transmission et cadrage d'équipe",
        impact:
          "mentorat d'une équipe de trois personnes chez Murex Systems, avec revues de " +
          "code, tests et intégration continue instaurés.",
      },
    ],
    problems_section:
      "Je suis certifié AWS Solutions Architect – Associate et Azure fait partie de mon " +
      "environnement technique ; votre parcours de certifications Microsoft est précisément " +
      "l'une des raisons pour lesquelles votre annonce m'intéresse. J'y ajoute le Mastère " +
      "Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO (certifié ASEP INCOSE), qui " +
      "structure ma façon de cadrer une architecture avant de la construire.",
  },

  28: {
    slug: "ingenieur-devops-sogeti",
    role_title: "Ingénieur DevOps (réf. 1276300501)",
    city: "Blagnac",
    opening:
      "Docker, Kubernetes, Jenkins, Git et Terraform : votre annonce liste exactement la " +
      "chaîne d'outils avec laquelle je travaille au quotidien depuis mon passage chez " +
      "Green Praxis, où j'ai eu la charge complète d'une plateforme en production.",
    profile_intro:
      "J'y ai provisionné les nœuds AWS EKS avec Terraform et Karpenter, déployé les " +
      "services via Helm et industrialisé la chaîne CI/CD — lint, tests, build, image " +
      "Docker et déploiement — tout en assurant l'exploitation de niveaux 2 et 3.",
    achievements: [
      {
        lead: "Industrialisation mesurable",
        impact:
          "modules Terraform réutilisables et pipelines GitHub Actions, avec une latence " +
          "P95 d'API ramenée de 600 ms à 220 ms et un stockage réduit de 80%.",
      },
      {
        lead: "Supervision et disponibilité",
        impact:
          "Prometheus et Grafana déployés par Helm, 24 tableaux de bord et 35 règles " +
          "d'alerte couvrant 95% des chemins critiques, SLA supérieur à 98%.",
      },
      {
        lead: "Environnements applicatifs variés",
        impact:
          "services backend en Python/FastAPI et Node.js/Express conteneurisés, et une " +
          "plateforme d'analyse de logs conçue et pilotée chez Murex Systems.",
      },
    ],
    problems_section:
      "Le Mastère Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO (certifié ASEP " +
      "INCOSE) m'a appris à spécifier et vérifier avant de livrer. Dans un contexte de " +
      "conseil, c'est ce qui permet de transformer un besoin client flou en chaîne de " +
      "déploiement documentée et reproductible.",
  },

  30: {
    slug: "consultant-devops",
    role_title: "Consultant DevOps (réf. 1366344433)",
    city: "Toulouse",
    opening:
      "Concevoir et maintenir des pipelines CI/CD, administrer des clusters Kubernetes et " +
      "porter une expertise technique au sein d'une squad : c'est le contenu de mon poste " +
      "chez Green Praxis, où j'étais responsable de la plateforme de bout en bout.",
    profile_intro:
      "J'y ai administré un cluster AWS EKS provisionné par Terraform et Karpenter, " +
      "industrialisé les déploiements via Helm et GitHub Actions, et assuré l'exploitation " +
      "de niveaux 2 et 3 sur les plateformes Linux sous-jacentes.",
    achievements: [
      {
        lead: "Administration Kubernetes en production",
        impact:
          "autoscaling dynamique des nœuds, déploiements Helm sans interruption, et un SLA " +
          "de pipeline maintenu au-dessus de 98%.",
      },
      {
        lead: "Automatisation du déploiement et de la configuration",
        impact:
          "infrastructure entièrement décrite en modules Terraform réutilisables — VPC, " +
          "IAM au moindre privilège, EKS — et pipelines d'intégration continue complets.",
      },
      {
        lead: "Expertise diffusée dans l'équipe",
        impact:
          "mentorat d'une équipe de trois personnes chez Murex Systems et instauration des " +
          "revues de code, des tests et de l'intégration continue.",
      },
    ],
    problems_section:
      "Sur le volet avant-vente, ma formation à l'ISAE-SUPAERO en ingénierie des systèmes " +
      "(certifié ASEP INCOSE) m'a entraîné à formaliser un besoin, spécifier des interfaces " +
      "et argumenter des compromis techniques — exactement ce qu'attend un client quand il " +
      "faut défendre une solution avant de la construire.",
  },

  41: {
    slug: "devops-automatisation",
    role_title: "Ingénieur DevOps – Automatisation (réf. 1249483201)",
    city: "Toulouse",
    opening:
      "L'automatisation des déploiements et de la configuration d'infrastructure, traitée " +
      "comme du code versionné, testé et revu : c'est le cœur de ce que j'ai construit chez " +
      "Green Praxis, et la pratique qui m'intéresse le plus dans votre annonce.",
    profile_intro:
      "J'y ai décrit l'intégralité de l'infrastructure AWS en modules Terraform " +
      "réutilisables — VPC, IAM au moindre privilège, EKS — et mis en place les pipelines " +
      "CI/CD qui les déploient, sur des environnements Linux que j'exploitais en niveaux " +
      "2 et 3.",
    achievements: [
      {
        lead: "Infrastructure as Code appliquée de bout en bout",
        impact:
          "provisionnement des nœuds EKS par Terraform et Karpenter, déploiements Helm, et " +
          "chaîne GitHub Actions couvrant lint, tests, build et livraison.",
      },
      {
        lead: "Sécurité et conformité intégrées au déploiement",
        impact:
          "IAM au moindre privilège, buckets S3 versionnés et gestion des secrets, avec une " +
          "supervision Prometheus/Grafana de 35 règles d'alerte.",
      },
      {
        lead: "Automatisation orientée résultat",
        impact:
          "plus de 15 DAGs Airflow d'ingestion, portant le débit de 8 à 48 scènes par heure, " +
          "et un SLA de pipeline supérieur à 98%.",
      },
    ],
    problems_section:
      "J'ajoute à cela un goût réel pour la documentation et le partage : le Mastère " +
      "Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO (certifié ASEP INCOSE) m'a " +
      "formé à écrire les exigences et les interfaces avant le code, et j'ai instauré les " +
      "revues et les tests dans l'équipe que j'encadrais chez Murex Systems.",
  },

  42: {
    slug: "devops-conteneurisation",
    role_title: "Ingénieur DevOps – Conteneurisation (réf. 1198758001)",
    city: "Toulouse",
    opening:
      "Mettre en place les outils d'industrialisation, assurer la disponibilité et la " +
      "supervision des infrastructures, et diffuser la culture DevOps chez le client : " +
      "c'est le poste que j'ai occupé de fait chez Green Praxis, où j'étais seul " +
      "responsable de la plateforme.",
    profile_intro:
      "Conteneurisation avec Docker et Kubernetes, déploiements par Helm sur AWS EKS, " +
      "infrastructure en Terraform et intégration continue : la chaîne complète, sur un " +
      "service en production avec des engagements de disponibilité.",
    achievements: [
      {
        lead: "Supervision comme discipline, pas comme option",
        impact:
          "Prometheus, Grafana et Loki déployés via Helm, 24 tableaux de bord et 35 règles " +
          "d'alerte couvrant 95% des chemins critiques, pour un SLA supérieur à 98%.",
      },
      {
        lead: "Industrialisation des déploiements",
        impact:
          "nœuds EKS provisionnés par Terraform et Karpenter pour un autoscaling dynamique, " +
          "et pipeline CI/CD complet jusqu'au Helm upgrade.",
      },
      {
        lead: "Culture technique transmise",
        impact:
          "mentorat d'une équipe de trois personnes chez Murex Systems, avec revues de code, " +
          "tests et intégration continue mis en place.",
      },
    ],
    problems_section:
      "L'intérêt pour l'open source et le scripting est ce qui m'a amené à ce métier, et le " +
      "Mastère Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO (certifié ASEP " +
      "INCOSE) lui a donné une méthode : exigences explicites, interfaces spécifiées, " +
      "vérification planifiée.",
  },

  53: {
    slug: "consultant-plm",
    role_title: "Consultant Ingénieur DEVOPS PLM (réf. 1198502201)",
    city: "Blagnac",
    opening:
      "Rédiger et exécuter des campagnes de test, suivre les anomalies avec les équipes " +
      "techniques et présenter l'avancement au client : ces trois activités décrivent la " +
      "façon dont j'ai travaillé chez Airbus, dans un contexte industriel exigeant.",
    profile_intro:
      "Chez Airbus Electric Center, je conçois actuellement l'architecture de données " +
      "qualité sur Skywise (Palantir Foundry) pour remplacer un suivi fragmenté des " +
      "non-conformités, en modélisant l'existant et la cible et en recueillant les " +
      "exigences auprès des parties prenantes qualité et ingénierie.",
    achievements: [
      {
        lead: "Vérification et validation comme métier",
        impact:
          "Mastère Spécialisé en Ingénierie des Systèmes de l'ISAE-SUPAERO : ingénierie des " +
          "exigences, stratégie de V&V et ISO/IEC 15288, appliquées sur les projets SUNSPEAR " +
          "et HydroART.",
      },
      {
        lead: "Qualité de données et réduction des anomalies chez Airbus",
        impact:
          "automatisation de la validation des données et définition de SLA, avec une " +
          "diminution de 90% des erreurs manuelles.",
      },
      {
        lead: "Relation client et restitution",
        impact:
          "recueil et affinage des exigences avec les clients chez Murex Systems, et " +
          "présentation des architectures aux parties prenantes.",
      },
    ],
    problems_section:
      "Je suis diplômé Bac+5 en informatique et titulaire du Mastère Spécialisé en " +
      "Ingénierie des Systèmes de l'ISAE-SUPAERO, avec un anglais technique courant et une " +
      "expérience directe des environnements industriels aéronautiques. L'outillage PLM " +
      "est un domaine que je serais heureux d'apprendre auprès de vos équipes.",
  },

  22: {
    slug: "ingenierie-systemes-electriques",
    role_title: "Ingénieur Systèmes Electriques (réf. 1200224001)",
    city: "Blagnac",
    opening:
      "Votre annonce demande la rédaction du System Requirements Document de l'architecture " +
      "et des Interface Control Documents des bus numériques. C'est précisément le travail " +
      "sur lequel m'a formé le Mastère Spécialisé en Ingénierie des Systèmes de " +
      "l'ISAE-SUPAERO, et que je pratique aujourd'hui chez Airbus.",
    profile_intro:
      "Je suis actuellement ingénieur systèmes et qualité chez Airbus Electric Center, où " +
      "j'applique les principes de l'ingénierie système pour modéliser les architectures " +
      "de données « as-is » et « to-be » et garantir leur intégrité, en lien avec les " +
      "parties prenantes qualité et ingénierie.",
    achievements: [
      {
        lead: "Exigences, interfaces et V&V sur des projets systèmes",
        impact:
          "sur SUNSPEAR, responsable du CONOPS, des exigences, des ICDs et de la stratégie " +
          "de vérification, avec livraison d'une architecture de référence.",
      },
      {
        lead: "Budgets système et contrôle d'interfaces",
        impact:
          "sur HydroART, architecture de mission incluant les budgets de masse, de puissance " +
          "et de données, le contrôle des interfaces et la planification V&V.",
      },
      {
        lead: "Modélisation et outillage",
        impact:
          "MBSE avec SysML et Capella, ISO/IEC 15288, et une pratique du calcul scientifique " +
          "en Python et C++ pour l'analyse de systèmes.",
      },
    ],
    problems_section:
      "Certifié ASEP (INCOSE), je travaille depuis mai 2026 dans un centre dédié aux " +
      "systèmes électriques aéronautiques, ce qui m'a familiarisé avec les contraintes de " +
      "ce domaine et son vocabulaire. Je candidate sur le volet architecture et exigences " +
      "de ce poste, là où mon apport serait immédiat.",
  },

  44: {
    slug: "ingenierie-systemes-spatiaux",
    role_title: "Ingénieur Systèmes Spatiaux (réf. 1200232501)",
    city: "Blagnac",
    opening:
      "L'ingénierie système satellite et l'analyse de mission sont le domaine dans lequel " +
      "j'ai choisi de me spécialiser : c'est le sujet de mon Mastère Spécialisé en " +
      "Ingénierie des Systèmes à l'ISAE-SUPAERO, et celui de mes deux projets de mission.",
    profile_intro:
      "Sur SUNSPEAR, projet véhicule et mission de l'ISAE-SUPAERO, j'étais responsable du " +
      "CONOPS, des exigences, des Interface Control Documents et de la stratégie de " +
      "vérification et validation, avec la livraison d'une architecture de référence et " +
      "des interfaces clés.",
    achievements: [
      {
        lead: "Analyse de mission et architecture système",
        impact:
          "sur HydroART, architecture de mission complète : budgets de masse, de puissance " +
          "et de données, contrôle des interfaces et planification de la V&V.",
      },
      {
        lead: "Méthode d'ingénierie système formelle",
        impact:
          "MBSE (SysML, Capella), ingénierie des exigences et ISO/IEC 15288, sanctionnés par " +
          "la certification ASEP de l'INCOSE.",
      },
      {
        lead: "Chaînes de données et opérations en environnement aéronautique",
        impact:
          "chez Airbus, architecture des flux de données du projet OPTIMATE et pipelines " +
          "d'ingestion géospatiale portés de 8 à 48 scènes par heure chez Green Praxis.",
      },
    ],
    problems_section:
      "Je travaille actuellement chez Airbus Electric Center et je suis installé à Toulouse, " +
      "au cœur de l'écosystème spatial européen. Ce poste correspond exactement à la " +
      "trajectoire que j'ai construite en choisissant l'ISAE-SUPAERO, et je serais heureux " +
      "de vous exposer mes travaux de mission en détail.",
  },

  29: {
    slug: "data-analytics",
    role_title: "Ingénieur Data Analytics Expérimenté (réf. 1290478601)",
    city: "Blagnac",
    opening:
      "Architectures de données et processus ETL/ELT : c'est le fil conducteur de mon " +
      "parcours, d'Airbus où j'ai unifié des sources RH hétérogènes sur cinq régions, à " +
      "Green Praxis où j'ai construit une chaîne d'ingestion géospatiale complète.",
    profile_intro:
      "J'ai conçu plus de 15 DAGs Airflow d'ingestion et de transformation, et des flux ETL " +
      "Python consolidant des sources disparates ; aujourd'hui, chez Airbus Electric Center, " +
      "j'architecture un pipeline de données qualité centralisé sur Skywise (Palantir " +
      "Foundry).",
    achievements: [
      {
        lead: "Débit et fiabilité des pipelines",
        impact:
          "ingestion géospatiale portée de 8 à 48 scènes par heure, avec un SLA de pipeline " +
          "maintenu au-dessus de 98%.",
      },
      {
        lead: "Consolidation de sources hétérogènes chez Airbus",
        impact:
          "flux ETL Python unifiés sur cinq régions, réduisant de 80% le temps de " +
          "déploiement des tableaux de bord.",
      },
      {
        lead: "Qualité de données automatisée",
        impact:
          "validation systématique et SLA définis, avec une baisse de 90% des erreurs " +
          "manuelles.",
      },
    ],
    problems_section:
      "Je travaille en SQL et PostgreSQL au quotidien, et la curiosité technologique que " +
      "vous recherchez est ce qui m'a conduit du développement backend vers l'ingénierie de " +
      "données puis vers l'ingénierie système à l'ISAE-SUPAERO. Monter en compétence sur " +
      "une nouvelle plateforme analytique est exactement le type de défi qui me motive.",
  },

  18: {
    slug: "ingenieur-logiciel",
    role_title: "Ingénieur Logiciel (réf. 1412150833)",
    city: "Toulouse",
    opening:
      "Je viens d'achever un Mastère Spécialisé à l'ISAE-SUPAERO après un Master " +
      "Informatique pour l'Aéronautique, et je cherche précisément ce que décrit votre " +
      "annonce : du développement applicatif exigeant, au sein d'une équipe agile, sur des " +
      "projets grands comptes.",
    profile_intro:
      "J'ai développé des services backend en production — une API FastAPI avec cache Redis " +
      "chez Green Praxis, des services Node.js/Express — et je pratique Java parmi mes " +
      "langages de travail, aux côtés de Python, C++ et C#.",
    achievements: [
      {
        lead: "Conception technique et choix d'architecture",
        impact:
          "refonte d'un service statique en passerelle à la demande, réduisant le stockage " +
          "de 80% et la latence P95 de 600 ms à 220 ms.",
      },
      {
        lead: "Qualité et fiabilité en production",
        impact:
          "revues de code, tests et intégration continue instaurés chez Murex Systems, où " +
          "j'ai encadré une équipe de trois personnes.",
      },
      {
        lead: "Usage raisonné de l'IA dans le cycle de développement",
        impact:
          "automatisation, APIs et traitement de données au cœur de mon travail quotidien, " +
          "avec une spécialisation en apprentissage automatique (Stanford/Coursera).",
      },
    ],
    problems_section:
      "Le Mastère Spécialisé en Ingénierie des Systèmes (certifié ASEP INCOSE) m'a apporté " +
      "une rigueur que je retrouve rarement à ce niveau d'expérience : formaliser les " +
      "exigences, spécifier les interfaces et planifier la vérification avant d'écrire le " +
      "code. C'est ce que j'apporterais à votre équipe dès le premier sprint.",
  },

  19: {
    slug: "software-engineer",
    role_title: "Software Engineer (réf. 1290377301)",
    city: "Toulouse",
    opening:
      "Concevoir et transformer des projets en microservices, réaliser les revues de code " +
      "et accompagner la montée en compétence de l'équipe : ce sont les trois axes de votre " +
      "annonce, et les trois choses que j'ai faites chez Murex Systems et Green Praxis.",
    profile_intro:
      "Chez Murex Systems, j'ai conçu et piloté une plateforme d'analyse de logs, architecturé " +
      "des composants modulaires avec des pipelines de déploiement automatisés sur Kubernetes " +
      "et Docker, encadré une équipe de trois personnes et instauré revues de code, tests et " +
      "intégration continue.",
    achievements: [
      {
        lead: "Architecture en services et déploiement continu",
        impact:
          "services conteneurisés déployés par Helm sur Kubernetes, avec une chaîne CI/CD " +
          "complète, chez Green Praxis comme chez Murex.",
      },
      {
        lead: "Développements complexes à impact mesuré",
        impact:
          "plateforme d'analyse de logs ayant révélé plus de cinquante types d'erreurs " +
          "jusque-là non détectés, et API dont la latence P95 est passée de 600 ms à 220 ms.",
      },
      {
        lead: "Mentorat et culture de revue",
        impact:
          "planification des jalons et des sprints, encadrement d'une équipe de trois " +
          "personnes et mise en place des pratiques de qualité.",
      },
    ],
    problems_section:
      "Je pratique Java parmi mes langages de travail, aux côtés de Python, C++ et C#, et " +
      "les cycles en V me sont familiers grâce au Mastère Spécialisé en Ingénierie des " +
      "Systèmes de l'ISAE-SUPAERO (certifié ASEP INCOSE), qui repose sur ISO/IEC 15288. " +
      "L'articulation entre agilité et cycle en V est un terrain que je connais bien.",
  },
};

const onlyArg = process.argv.indexOf("--only");
const selected =
  onlyArg > -1
    ? process.argv[onlyArg + 1].split(",").map((n) => n.trim())
    : Object.keys(LETTERS);

fs.mkdirSync(scratch, { recursive: true });
let built = 0;

for (const key of selected) {
  const L = LETTERS[key];
  if (!L) {
    console.error(`✗ no letter defined for #${key}`);
    process.exitCode = 1;
    continue;
  }

  const outPath = `output/lettre-motivation-capgemini-${L.slug}.pdf`;
  const payload = {
    candidate: CANDIDATE,
    letter: {
      role_title: L.role_title,
      company: "Capgemini",
      city: L.city,
      date: today,
      greeting: GREETING,
      opening: L.opening,
      profile_intro: L.profile_intro,
      achievements: L.achievements,
      problems_section: L.problems_section,
      closing: `${AVAILABILITY} ${CLOSING}`,
    },
    output_path: outPath,
  };

  const payloadPath = path.join(scratch, `cover-capgemini-${L.slug}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), "utf8");

  try {
    execFileSync(
      "node",
      ["generate-cover-letter.mjs", "--payload", payloadPath, "--format", "a4", "--report", key],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    );
    console.log(`✅ #${String(key).padStart(2)} → ${outPath}`);
    built++;
  } catch (err) {
    const detail = (err.stdout || "") + (err.stderr || "") || err.message;
    console.error(`❌ #${key} failed:\n${detail.trim()}`);
    process.exitCode = 1;
  }
}

console.log(`\n${built}/${selected.length} letter(s) built.`);
