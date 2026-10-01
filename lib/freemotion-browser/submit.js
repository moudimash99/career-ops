async (page) => {
  // Click the submit button (French or English label) and read the page text after it:
  // `ok` quotes a confirmation, `bad` quotes a refusal or error. Never click again if both are null.
  const names = [/^Je postule/i, /^Envoyer ma candidature/i, /^J.envoie ma candidature/i,/^Envoyer la candidature/i, /^Submit application/i, /^Send application/i, /^Envoyer$/, /^Submit$/i, /^Soumettre/i, /^Valider$/i, /^Postuler$/, /^Continuer ma candidature/i];
  let clicked = null;
  for (const n of names) { const b = page.getByRole('button', { name: n }); if (await b.count() && await b.first().isVisible()) { await b.first().click(); clicked = String(n); break; } }
  await page.waitForTimeout(6000);
  const t = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const ok = t.match(/.{0,80}(candidature sauvegardée|accusons réception|bien été envoyée|a été envoyée|candidature envoyée|a bien été (reçue|enregistrée|transmise)|bien reçu|merci pour votre candidature|thank you for (applying|your application)|application (has been )?(submitted|sent|received)|successfully submitted).{0,120}/i);
  const bad = t.match(/.{0,80}(déjà postulé|already applied|couldn.t submit|n'a pas pu|erreur|error|within the last \d+ days|champ obligatoire|required).{0,120}/i);
  return { clicked, url: page.url(), ok: ok ? ok[0] : null, bad: bad ? bad[0] : null };
}
