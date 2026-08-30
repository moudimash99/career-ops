# Free Motion Web Agent Architecture

## Overview

The Free Motion Web Agent is a highly resilient, cost-effective, plug-and-play auto-application framework for `career-ops`. It abandons brittle DOM-scraping rules and API reverse-engineering in favor of an agent-orchestrated "Read, Think, Do" cascade. 

The architecture relies on three tiers:
1. **Tier 1 (Deterministic Parser):** A fast script to fill standard fields and extract the remaining DOM.
2. **Tier 2 (Agent Orchestrator):** The `agy` CLI reads the remaining state, decides what to do, and issues targeted commands.
3. **Tier 3 (Eye in the Sky):** A visual LLM validates screenshots prior to submission.

## 3-Tier Cascade

### Tier 1: Deterministic Parser 
- **Goal:** Fill 70-90% of obvious fields (Name, Email, standard demographics) deterministically.
- **Cost:** $0, executes in milliseconds.


### Tier 2: Agent Orchestrator (`agy`)
- **Goal:** Handle edge cases, custom questions, and non-standard forms. It also is the one dictating the movement of the browser
- **Process:** The agy agent is the orchestrator. It reads the Tier 1 output, acts as a text-based LLM reasoner, and issues commands 

### Tier 3: Eye in the Sky Validator (`lib/tier3-validate.mjs`)
- **Goal:** as tier 2 html reader might not have a good picture, tier 3 should be able to easily validate if the application submission is not missing anything, and didnt fill in or choose anythign incorrectly. 
- **Process:** Before `agy` executes a "SUBMIT" action, it runs the Tier 3 script. This takes a screenshot of the browser context and sends it to a multi modal LLM . tier 3 should tell if everything is okay, and if not to tell to tier 2 what should be fixed and guide it there as tier 2 should have already missed it and doesnt know how to get there.
- ** Pitfalls ** I have already tried doing this before and even an llm wasn't able to take a good screenshot. if the form is inside another scrollable page and the form is multi page , this could be a blocking point. 


## Plug-and-Play Browser Engine

To bypass advanced anti-bot WAFs (Cloudflare Enterprise, DataDome, Turnstile), this system strictly abstracts browser instantiation 
the main target is to run the tool using camofoux browser so that we have tier 3 and tier 2 capabilities using that tool. However the main goal is to produce right now with a standard library that can be later replaced with camofoux later if need be. thus camofoux and the chosen tool of start should be easily replaced without any knowledge of coding later on. 