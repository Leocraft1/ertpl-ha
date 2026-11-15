# ERTPL HA

Router di discovery per Cloudflare Workers: restituisce l'URL del primo nodo disponibile dell'API richiesta. Come il router precedente, non inoltra le richieste applicative e non effettua redirect verso il nodo scelto.

Ogni API ha una lista statica indipendente in `src/apis.js`. A ogni richiesta il controllo riparte dalla priorità 1 e prosegue in sequenza solo se il nodo precedente fallisce: il failover e il ripristino della priorità al rientro valgono anche per START. Non ci sono master memorizzati, soglie di errori, cache dello stato o chiamate amministrative ai backend.

## Priorità

Sono conservati gli indirizzi e gli ordini del router originale.

| Endpoint | Priorità 1 | Priorità 2 | Priorità 3 | Controllo |
| --- | --- | --- | --- | --- |
| `/start` | Serverissimo | DaniLab | Vichingo455 | `/health` |
| `/mezzi` | Serverissimo | DaniLab | Vichingo455 | `/health` |
| `/cdn` | DaniLab | Serverissimo | Vichingo455 | `/health` |
| `/seta` | Serverissimo | DaniLab | Vichingo455 | `/health` |
| `/startsopp` | Serverissimo | DaniLab | Vichingo455 | `/versione` |
| `/tper` | Serverissimo | DaniLab | Vichingo455 | URL base |

Risposta con un nodo disponibile (HTTP 200):

```json
{"status":"ok","server":"https://startapi.serverissimo.com"}
```

Se nessun nodo dell'API è disponibile, la risposta è HTTP 503:

```json
{"status":"offline"}
```

**START restituisce ora l'URL base nel campo `server`, come tutte le altre API.** Il vecchio endpoint restituiva invece il nome del master memorizzato nell'Arbiter.

Sono supportati GET, HEAD e OPTIONS, CORS pubblico, slash finale e parametri query. Gli altri metodi restituiscono 405, i percorsi sconosciuti 404. Le risposte e i controlli dei backend usano `no-store`.

## Disponibilità e formati verificati

I formati sono stati verificati con `curl` sui 18 indirizzi configurati il 15 novembre 2026:

| API | Risposta osservata | Condizione di disponibilità oltre a HTTP 2xx |
| --- | --- | --- |
| START | JSON con `role` e `replication` | `master`, oppure `replica` con `caught_up: true` e nessun thread IO/SQL dichiarato fermo; esclusi i nodi con `resync_in_progress` |
| Mezzi | `{"status":"ok","primary":false}` | `status` uguale a `ok`; `primary` è informativo e non modifica la priorità |
| CDN, SETA | Testo `API is healthy and running.` | Messaggio corrispondente, ignorando spazi e newline esterni |
| Startsopp | `{"version":"2.0.1"}` | `version` stringa non vuota |
| TPER | JSON con `name: "tper-api"`, `version: "2.0.0"`, autore e descrizione | Nome corrispondente e versione non vuota |

Al momento della verifica START Vichingo455 è andato in timeout e Mezzi Vichingo455 ha risposto 404: gli indirizzi restano nella lista e vengono ricontrollati normalmente. TPER Vichingo455 risponde prima con un redirect verso `/tper/`, seguito dal JSON atteso; il controllo segue i redirect.

Il timeout per nodo è di 3 secondi per START e 1,5 secondi per le altre API, come nei controlli preesistenti. Comprende anche la lettura del corpo, limitato a 64 KiB. Errori di rete, timeout, errori HTTP, JSON non valido e risposte che dichiarano un servizio non disponibile fanno passare al nodo successivo.

## Stato dei nodi

- `GET /status`: verifica tutti i nodi di tutte le API.
- `GET /status/start` (oppure un altro nome API): verifica solo i tre nodi di quell'API.
- `GET /debug`: alias di `/status`.

Il report contiene `checkedAt` e un oggetto `apis` indicizzato per nome API. Per ciascuna API espone `status` (`ok` oppure `offline`), `server` (URL del primo nodo disponibile, oppure `null`) e `nodes` nell'ordine statico di priorità.

Ogni nodo contiene:

- `name`, `priority`, `server`, `healthUrl`: identità e posizione nella lista.
- `reachable`: sono stati ricevuti gli header HTTP, anche in caso di errore del backend.
- `available`: il nodo può essere scelto dal router.
- `httpStatus`: codice HTTP ricevuto, oppure `null` se la connessione non ha restituito header.
- `details`: risposta JSON del backend, oppure testo per CDN/SETA; `null` se non leggibile o non decodificabile.
- `error`: `null`, `timeout`, `network_error`, `http_<codice>`, `invalid_response`, `unhealthy_response` o `response_too_large`.

Per START `details` conserva ruolo e informazioni sul database, inclusi `master_host`, `io_running`, `sql_running`, `lag_seconds`, `caught_up` e gli eventuali altri campi restituiti da `/health`. I dettagli leggibili sono mantenuti anche quando il backend risponde con un errore HTTP. Un nodo può quindi essere raggiungibile ma non disponibile, ad esempio una replica non allineata.

Lo `status` complessivo è `ok` se tutti i nodi sono disponibili, `degraded` se almeno un nodo non è disponibile ma almeno un'API funziona, `offline` se nessuna API ha nodi disponibili. Il report restituisce HTTP 200 anche quando segnala guasti; gli endpoint di discovery restituiscono invece 503 quando l'API richiesta è offline.

Il report interroga tutti i nodi, con al massimo sei controlli contemporanei, e sceglie il server per priorità, indipendentemente dall'ordine di completamento. Il limite di concorrenza tiene conto dei [limiti di connessione di Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections). Non raccoglie statistiche sulle porte o dati di deploy. Lo stato è un'osservazione al momento dei controlli, non una garanzia sulla richiesta applicativa successiva.

## Compatibilità e test locali

Il binding e la migrazione Wrangler esistenti sono mantenuti, insieme a una classe `Arbiter` inerte, per consentire l'aggiornamento del Worker senza eliminare lo storage precedente. Il nuovo router non usa il Durable Object. Eventuali alarm già pendenti terminano senza azioni e senza riprogrammarsi; non serve `ARBITER_SECRET`.

I test usano solo il runner integrato di Node.js e risposte simulate basate sui formati osservati, senza dipendenze:

```sh
npm test
```

Coprono priorità e failback delle sei API, failover su entrambi i nodi di riserva, isolamento fra API, stati del database START, report completo e per API, timeout anche durante la lettura del corpo, risposte malformate, limiti del corpo, CORS e compatibilità dell'Arbiter inerte. Non eseguono Wrangler né deploy.
