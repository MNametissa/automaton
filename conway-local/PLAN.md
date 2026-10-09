# Automaton standalone : demandes, audit du dépôt et exécution

## Périmètre demandé

- Fork GitHub MNametissa/automaton, clone séparé, branche feat/standalone-runtime.
- Continuer le travail discuté dans « Analyse des réseaux wifi ».
- Au lancement : connaître la mission, les outils utilisables, les limites et le travail en cours ; s’auditer avant d’agir.
- Décider, planifier, exécuter, vérifier, corriger et reprendre sans sollicitation humaine routinière.
- Évaluer les trois missions : logiciel testé/corrigé, site servi et vérifié, rapport fondé sur des sources.
- Skills demandés : Superpowers et Ponytail, complétés par audit et rédaction ; utilisables par le principal et les travailleurs.
- Outils demandés : REA et Mimic, réellement exécutables dans le runtime.
- Finalité principale précisée par le créateur : gagner des revenus réels en ligne et payer ses ressources avec ces revenus. Les trois missions locales sont des évaluations de capacités.
- Le score artificiel erreurs/récompenses et son ajustement de tours sont retirés à la demande du créateur ; les erreurs restent des observations utiles pour corriger le travail.
- Budget externe autorisé : 0 $. Une allocation locale est une simulation ; elle ne constitue ni un paiement ni un solde fournisseur.
- L’autonomie demeure dans les ressources et autorisations configurées. Un prérequis absent doit être enregistré ; l’agent poursuit les travaux indépendants ou attend une condition de reprise, sans inventer de résultat.

## Audit de l’existant

Référence : commit upstream d8f816881fd24b6f5e3d616e59edec387a447667. Les constats ci-dessous concernent cette base, pas les ajouts standalone.

| Circuit | Déjà implémenté | Limite vérifiée dans le code |
|---|---|---|
| Démarrage | Configuration, identité, base SQLite, clients, règles, skills, dépôt d’état Git, heartbeat, boucle | Le premier prompt demande d’inspecter l’environnement ; aucun audit global obligatoire avant inférence |
| Mission | genesisPrompt, message du créateur au premier tour, SOUL.md, WORKLOG.md, statut dynamique | Une consigne injectée ne garantit pas sa compréhension ni son exécution ; genesis tronqué dans une couche du prompt |
| Objectifs | create_goal, DAG, dépendances, statuts persistants, détection de cycles | create_goal limite à un objectif actif ; set_goal est une entrée de mémoire distincte et ne lance pas le DAG |
| Planification | Classification, plan structuré, plans versionnés, replanification après échec | Revue auto approuve même au-dessus du seuil ; consensus est explicitement un stub ; supervisé attend une approbation |
| Exécution | Boucle principale, travailleurs locaux, harnais général/code/orchestration, outils et politiques | La branche de création cherche d’abord Conway puis replie localement ; plusieurs piles d’inférence à configurer |
| Enchaînement local | Pool de travailleurs locaux exécutant chacun une tâche | Les anciens travailleurs pouvaient être réutilisés sans nouveau lancement ; corrigé dans la branche avec test de deux tâches dépendantes |
| Budget du planificateur | Contexte financier transmis au plan | La lecture du solde parent interrogeait seulement les enfants et renvoyait zéro ; corrigé dans la branche |
| Vérification | Résultats typés, états de tâches, outil verify_result | verify_result utilise >=50 % de correspondance de mots ; succès du travailleur peut clôturer la tâche sans test indépendant |
| Reprise | Historique SQLite, état de l’orchestrateur, remise en attente de tâches assignées à des travailleurs disparus | Le contexte perd les appels d’outil si le texte assistant est vide ; récupération observée porte sur assigned, pas une garantie universelle |
| Mémoire | Travail, épisodes, faits, procédures, relations ; ingestion après tour et récupération avant tour | Extraction largement heuristique ; la boucle principale utilise MemoryRetriever, pas automatiquement tous les modules avancés présents |
| Auto-réflexion | reflect_on_soul, historique, mise à jour des capacités/relations selon les traces | Alignement lexical Jaccard/recall ; pas audit fonctionnel. Tâche heartbeat disponible mais absente des six entrées par défaut |
| Outils | Shell, fichiers, Git, skills, services Conway, paiements, identité, enfants, messagerie | Le registre expose des outils dont les dépendances peuvent manquer ; chemins /root et ~/.automaton supposés |
| MCP | Enregistrement de configuration et outil installé | Exécuteur MCP renvoie un texte sans appeler le protocole : navigateur/bureau non fournis par ce mécanisme |
| Anti-boucle | Détection d’appels identiques, motifs répétés, tours inactifs, plafonds de cycle | Peut forcer veille/échec ; ne crée pas à lui seul une nouvelle stratégie correcte |
| Heartbeat | Ordonnanceur durable, baux, cron, historique, délais, relances, réveils | Exécuté dans le processus ; ne redémarre pas à lui seul un processus mort |
| Santé des enfants | Surveillance de crédits, heartbeat, erreurs, réaffectation | restartAgent envoie une demande d’arrêt puis marque starting ; pas preuve de redémarrage réussi |
| Auto-modification | Fichiers protégés, contrôle des chemins, limites, snapshots, audit, retour arrière | Éditer son code ou mémoriser une procédure n’entraîne pas les poids du modèle ; pas qualification automatique complète |
| Argent | Crédits Conway, USDC, x402, suivi des dépenses et limites, modes de calcul réduits | Solde réel externe et ledger local sont différents ; pas preuve de revenus ni rapprochement fournisseur standalone |

### Circuit natif à conserver

Configuration → identité/SQLite → règles/outils/skills → contexte de réveil → récupération mémoire → orchestration → choix du modèle → action → résultat → persistance/mémoire → détection de boucle → nouvelle action ou veille → heartbeat → reprise.

Pour un objectif complexe : objectif → classification → plan → revue → tâches prêtes selon dépendances → travailleurs → collecte → succès ou replanification (trois par défaut) → état terminal.

## Changements de la branche

| Lot | Réalisation | Validation / limite |
|---|---|---|
| Fork et clone | Origin MNametissa, upstream Conway ; clone original conservé | Branche dédiée, aucun déploiement distant |
| Passerelle locale | Identité signée, crédits simulés, messages, relais modèle local, CLI contrôle | Tests HTTP et clients réels ; modèles de test simulés |
| Robustesse passerelle | Nonces, idempotence transferts, déduplication messages, erreurs amont, timeouts, pause | Aucun fournisseur payant ni création de fonds |
| Routage standalone | Même modèle local pour boucle, planificateur, travailleurs et niveaux de calcul | Clés de fournisseurs ambiantes exclues des routes standalone |
| Audit au démarrage | Mission, répertoire accessible, intégrité SQLite, objectifs/tâches, allocation et catalogue modèle ; rapport persisté avant inférence | Catalogue ne prouve pas qualité ou bon fonctionnement du modèle ; outil self_audit pour réévaluation |
| Capacités honnêtes | Outils externes non fournis exclus ; MCP sans transport exclu | Aucun navigateur/bureau implicitement annoncé |
| Reprise et chemins | Tours contenant uniquement des outils restaurés ; chemins d’état et de travail configurables | Tests ciblés de reprise et écriture par outil |
| Isolation | Image Node 22, utilisateur non privilégié ; smoke test sans réseau, sans clés hôte, racine en lecture seule | Script de smoke test utilise stockage temporaire ; ce n’est pas encore un déploiement persistant |
| Évaluation | Trois missions et critères définis dans missions.json | Aucun benchmark avec vrai modèle effectué |
| Budget des paiements USDC | Migration SQLite V12 ; réservation atomique partagée entre x402 et toutes les recharges ; plafonds explicites total, quotidien UTC et par paiement | Absent = 0 ; standalone impose 0. Plafonds en centimes, montants atomiques conservés ; réservation arrondie au centime supérieur. Ce budget ne couvre pas les transferts USDC directs, les crédits Conway transférés ou les factures d’inférence |
| Émission et comptabilité | Montants x402 v1/v2 en unités atomiques ; domaine USDC Base/Base Sepolia ; HTTPS et domaines autorisés ; signature EIP-3009 seulement | Permit2, ERC-7710, upfront et escrow refusés. HTTP 200 ne prouve pas le débit. Confirmation via receipt, Transfer exact, AuthorizationUsed du nonce et deux confirmations RPC ; pas de garantie de finalité économique |
| Reprise des achats | Résultat HTTP durable ; même opération et purchase_id rejoue le résultat confirmé ; nouvelle intention explicite pour racheter | Aucun nouvel ID ne débloque une opération encore incertaine ou sans livraison vérifiée. Les recharges automatiques sans ID n’achètent pas indéfiniment : après le premier achat, l’agent doit examiner son solde et demander une nouvelle recharge avec un nouvel ID |
| Rapprochement | Heartbeat traite au plus deux tentatives par passage ; écritures comptables atomiques et uniques ; payment_status et reconcile_payment disponibles | Recherche automatique des hashes perdus pour les nouvelles tentatives ; anciens paiements sans repère de bloc à rapprocher avec un hash fourni. Aucun remboursement ni récupération automatique d’une livraison manquante |
| Recherche après coupure | Migration V13 ; bloc finalisé enregistré avant signature ; recherche AuthorizationUsed par contrat/payeur/nonce, puis reçu intégral vérifié | Au plus 2 000 blocs finalisés par tentative et passage ; curseur durable, sans avancement sur erreur RPC. Une page vide ne libère jamais le budget. Le rattrapage peut demander plusieurs passages et attend la finalisation des blocs. Si le repère initial est inaccessible, aucune signature n’est émise |
| Vérification mesurée | verify_result abandonne les mots-clés ; verify_task exécute des scripts Node avec stdin/exit/JSON attendus, des requêtes HTTP locales et des contrôles de citations | Contrôles limités en temps et volume, chemins réels confinés ; le processus hérite de l’isolation du runtime, ce n’est pas une sandbox supplémentaire. La couverture des critères dépend des contrôles choisis |
| Clôture standalone | Objectifs conservés actifs jusqu’à preuve persistée pour chaque tâche ; preuve liée au résultat et aux entrées contrôlées, réexécution commune de tous les contrôles avant certificat final ; coordinateur refuse une clôture prématurée | Une tâche « completed » signifie encore fin d’exécution et débloque ses dépendances. L’acceptation finale de l’objectif est distincte. Comportement historique conservé pour les objectifs non soumis à cette règle hors standalone |
| Skills réellement consultables | 25 workflows embarqués : Superpowers 6.4.2, Ponytail 2.0.0, insecure-defaults Trail of Bits épinglé, rédaction Strunk ; sources/licences conservées dans resources/skills | use_skill consulte instructions et références par pages, catalogue partagé principal/travailleurs, trois entrées chargées au démarrage ; traces SQLite prouvent la livraison, pas l'application correcte par le modèle |
| Analyse REA/Mimic | REA 6.1.0 et Mimic commit 8cf998ac installés séparément ; cinq outils typés pour JS, HAR, hôtes, endpoints et prompt de client Python | Installateur reproductible, probes CLI et vrais essais synthétiques ; Node 22, Python/venv et procps dans l’image ; analyse offline seulement. Aucun provider natif, capture de trafic, proxy hôte ou générateur Claude payant activé. Les commandes CLI restent dans l'environnement dédié |
| Rapports | Les citations sont comparées aux textes des sources identifiées ; citations inventées refusées | Même des citations exactes produisent un résultat inconclusif : soutien sémantique, exhaustivité et calculs ne sont pas garantis. Aucun benchmark avec vrai modèle ni validateur sémantique indépendant installé |

## Travail restant pour l’autonomie opérationnelle

### Préparation I AM Alive — 9 octobre 2026

Le dossier `profiles/i-am-alive/` contient un mandat complet à relire (`genesis.txt`),
un manifeste de déploiement **non exécutable** (`deployment.review.json`) et la revue
des prérequis (`REVIEW.txt`). L'opérateur demande de modifier et valider avant lancement.
Le nom retenu est I AM Alive. Aucun état personnel, wallet ou credential n'est écrasé.

La mission n'est plus coupée à 2 000 caractères dans le prompt système. L'outil natif
`runpod_status`, principal et travailleurs, observe solde du compte, débit horaire et
télémétrie des pods en lecture seule. La CLI `node conway-local/runpod-status.mjs --watch`
offre un polling de 60 secondes sans inférence ni mutation fournisseur. Clé par fichier
privé `RUNPOD_API_KEY_FILE` ou environnement `RUNPOD_API_KEY` ; erreurs sans secret.
Le compte entier n'est pas l'enveloppe de l'agent. Le raccordement réel reste à vérifier
avec une clé fournie ; la référence MCP locale n'est pas une clé remise au runtime.

`gh` confirme MNametissa et son accès ADMIN au fork. L'identité GitHub d'exploitation
n'est pas créée. Une GitHub App sur ce dépôt est proposée ; son provisionnement,
la promotion de versions, le déploiement du superviseur, le contrôleur de budget commun,
le monitoring continu et le circuit marchand restent à réaliser après revue.
Le budget externe demeure 0 $. Aucune ressource payante ni aucun modèle lancé.

Autonomie locale ajoutée : pool conservé entre réveils, quatre travailleurs simultanés
par défaut (`maxLocalWorkers`), tâches excédentaires en attente, affectation atomique,
récupération des tâches assigned/running orphelines et arrêt coopératif borné à cinq
secondes. En standalone, les anciens enfants distants ne sont plus réutilisés.
Les workers sont des tâches asynchrones du même processus ; aucun pod supplémentaire.

`conway-local/supervision.mjs` prépare une configuration Supervisor 4.3.0 pour gateway,
agent et observateur Runpod optionnel. Il exige un état standalone déjà provisionné
avec le même control.db et ne lance aucun service. Le superviseur est dans l'image.
Un test réel tue le processus de test, vérifie la relance, la persistance et l'arrêt.
`profiles/i-am-alive/heartbeat.yml` propose le réveil check_work chaque minute et
les métriques toutes les cinq minutes ; aucun état utilisateur modifié. Le réveil
demande du travail prêt, de la planification/reprise ou une vérification finale,
avec allocation positive et déduplication. Cette supervision ne rallume pas un pod
arrêté et ne garantit pas une seule exécution des effets externes après un crash.

### Priorités suivantes

1. Priorité économique : relier une offre réelle à des clients, commandes, paiements reçus vérifiés, livraisons et coûts fournisseurs. Le portefeuille récepteur et les paiements sortants ne constituent pas ce circuit marchand. Corriger la comptabilité avant toute mesure de rentabilité : le rapport heartbeat classe encore credit_purchase comme revenu et ne couvre pas tous les décaissements. Un achat de crédits consomme de la trésorerie ; il ne prouve pas une vente.
2. Compléter la couverture des critères : contrats fixés avant délégation, validation avant déblocage de chaque dépendance, support des piles autres que Node et validation sémantique indépendante des rapports. Les contrôles exécutables remplacent désormais la validation lexicale du coordinateur ; la clôture des objectifs standalone exige ces preuves.
3. Relier réellement les transports MCP et leurs vérifications de santé avant d’ajouter navigateur ou bureau.
4. Tester les trois missions avec un vrai modèle local disponible, conserver traces, temps, tokens, erreurs et interventions. À 0 $, aucune instance GPU payante à créer.
5. Préparer le déploiement persistant sur les machines autorisées : volumes séparés, supervision de processus, récupération après arrêt, contrôle réseau. Le smoke test isolé ne remplace pas ce travail.
6. Si un budget externe est autorisé plus tard : facturation fournisseur, budget commun à toutes les catégories (au-delà du circuit x402 désormais réservé), rapprochement des coûts, arrêt des ressources. Une commande fund locale n’effectue aucun paiement. Un achat USDC nécessite des fonds réels préalablement présents dans le portefeuille ; configurer un plafond ne crée ni ne débite de l’argent.
7. Compléter la récupération des anciens paiements sans repère de bloc, des signatures interrompues et des livraisons manquantes ; évaluer le protocole auprès d’un fournisseur avant activation. Revenus et trading restent des intégrations distinctes non implémentées et non évaluées.

## Commandes de validation

Utiliser Node 22.19.0 (fichier .nvmrc), puis :

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
node conway-local/install-analysis-tools.mjs
AUTOMATON_ANALYSIS_SMOKE=1 pnpm exec vitest run src/__tests__/analysis-tools.test.ts --maxWorkers=2 --minWorkers=1
pnpm test --maxWorkers=2 --minWorkers=1
pnpm test:local
docker build -f conway-local/Dockerfile -t mnametissa-automaton:standalone .
bash conway-local/run-isolated.sh
```

Initialisation explicite d’un état dédié, sans démarrer l’agent ni lui fournir d’argent :

```sh
pnpm local:setup --state-dir /chemin/etat-dedie --api-url http://127.0.0.1:8787 --creator ADRESSE_EVM --model local --mission all
pnpm local:setup --state-dir /chemin/etat-dedie --status
```

Le lancement du runtime utilise AUTOMATON_DIR pour l’état et AUTOMATON_WORKSPACE pour le travail. L’environnement doit être isolé avant de lancer une mission non déterministe. Le profil de configuration seul ne constitue pas une sandbox : un shell lancé directement sur l’hôte hérite de son environnement. L’isolation démontrée est celle du conteneur sans accès aux clés hôte. Les commandes de contrôle pause/resume/kill bloquent ou rétablissent le relais ; kill n’éteint pas une machine distante.
