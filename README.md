# 🚆 Treni — Arrivi, partenze e stato dei treni

Web app italiana, progettata per iPhone e desktop, pubblicata **esclusivamente con GitHub Pages e GitHub Actions**, senza server, database o servizi aggiuntivi.

> **Attenzione:** questa applicazione visualizza **fotografie periodiche**, non dati live interrogati su richiesta. Solo le stazioni configurate vengono monitorate. Fonte: API non ufficiali ViaggiaTreno, soggette a modifiche/interruzioni. Progetto indipendente, non affiliato a Trenitalia.

## Come attivare il sito

1. Apri **[Settings → Pages](https://github.com/bolkan/Treni/settings/pages)**.
2. Seleziona **Build and deployment → Source → GitHub Actions**.
3. Vai su **[Actions → Aggiorna dati e pubblica Treni](https://github.com/bolkan/Treni/actions/workflows/deploy.yml)** e premi **Run workflow** per avviare subito un aggiornamento.
4. Dopo un workflow riuscito, apri **https://bolkan.github.io/Treni/**.

Se la prima esecuzione fallisce, controlla i log del job *Raccogli dati e prepara il sito*: l'API non ufficiale può essere temporaneamente indisponibile o cambiare risposta. Se il job di pubblicazione non riesce, verifica di avere scelto **GitHub Actions** come sorgente di Pages.

## Funzioni

- Ricerca per **città e nome stazione**; scegliere tra più stazioni che contengono il nome.
- **Partenze e arrivi** delle stazioni monitorate, con orario, categoria e numero treno, destinazione/provenienza, binario, ritardo o soppressione dove comunicati.
- Ricerca per **numero del treno** negli snapshot disponibili e scheda con le presenze nei tabelloni monitorati; collegamento alla **scheda ufficiale**.
- **Preferiti** salvati sul dispositivo, ricerca e filtro rapido, indicatore di aggiornamento e avviso di dati vecchi.
- Grafica responsive e **PWA** installabile tramite browser.

## Schema tecnico

```text
ViaggiaTreno (API non ufficiale)
       |
       | GitHub Actions ogni 15 minuti (orario indicativo)
       v
scripts/collect.py  ->  _site/data/{stations,live}.json
       |
       v
artifact GitHub Pages -> https://bolkan.github.io/Treni/
       |
       v
Browser: HTML/CSS/JavaScript + preferiti locali
```

Il browser **non interroga direttamente** ViaggiaTreno (problemi CORS e possibili blocchi). Nessun commit di dati ripetuto ogni 15 minuti: il workflow distribuisce un nuovo artifact Pages. Il catalogo nazionale delle stazioni viene memorizzato in una **cache giornaliera GitHub Actions** quando la fonte è raggiungibile.

### Aggiungere/rimuovere stazioni monitorate

Modifica **[`config/monitor.json`](config/monitor.json)**. L'array `stations` contiene nomi esatti di stazioni (es. `"MESSINA CENTRALE"`). I nomi vengono risolti tramite il catalogo ViaggiaTreno. Il workflow successivo leggerà la configurazione aggiornata.

Per rispetto della fonte non ufficiale, evita di monitorare centinaia di stazioni. La ricerca nel catalogo può riguardare altre città, ma **senza il tabellone** finché non le aggiungi a `monitor.json`.

### Modificare la frequenza

In **[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)** cambia la riga `cron`. L'intervallo attuale è **15 minuti**. GitHub può ritardare o saltare gli avvii programmati e, dopo lunghi periodi di inattività pubblica, disattivare il calendario.

## Prove e avvio locale

- Python 3.12, senza librerie esterne; Node.js solo per verificare la sintassi del frontend.
- Test: `python -m unittest discover -s tests -v`.
- Verifica JS: `node --check public/app.js`.
- Generazione reale: `python scripts/collect.py` (richiede accesso a ViaggiaTreno).
- Demo locale dopo la raccolta: `python -m http.server 8080 -d _site`.

## Limiti da conoscere

- Nessuna interrogazione **live** di un numero/stazione arbitraria: serve in futuro un servizio dati accessibile su richiesta.
- In caso di mancata risposta dell'API i dati **non sono inventati**: il sito mostra una condizione di errore.
- La ricerca per città è un confronto sul **nome della stazione**, non sull'anagrafe dei comuni.
- La scheda treno mostra solo le **presenze nei tabelloni acquisiti**, non l'intero percorso.
- I binari possono non essere comunicati o essere modificati; gli annunci ufficiali prevalgono sempre.
- La frequenza pianificata non equivale a pubblicazione o aggiornamento garantito ogni 15 minuti.

Riferimenti: [Documentazione API non ufficiale ViaggiaTreno](https://github.com/dltmtt/viaggiatreno-api) · [GitHub Pages con Actions](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
