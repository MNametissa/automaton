# Automaton standalone : demandes, audit du dépôt et exécution

## Périmètre demandé

- Fork GitHub MNametissa/automaton, clone séparé, branche feat/standalone-runtime.
- Continuer le travail discuté dans « Analyse des réseaux wifi ».
- Au lancement : connaître la mission, les outils utilisables, les limites et le travail en cours ; s’auditer avant d’agir.
- Décider, planifier, exécuter, vérifier, corriger et reprendre sans sollicitation humaine routinière.
- Évaluer les trois missions : logiciel testé/corrigé, site servi et vérifié, rapport fondé sur des sources.
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

## Travail restant pour l’autonomie opérationnelle

1. Remplacer les validations lexicales par des critères exécutables selon la mission : tests, HTTP, fichiers, vérification des sources. Ne jamais déduire la réussite de la seule déclaration d’un travailleur.
2. Relier réellement les transports MCP et leurs vérifications de santé avant d’ajouter navigateur ou bureau.
3. Tester les trois missions avec un vrai modèle local disponible, conserver traces, temps, tokens, erreurs et interventions. À 0 $, aucune instance GPU payante à créer.
4. Préparer le déploiement persistant sur les machines autorisées : volumes séparés, supervision de processus, récupération après arrêt, contrôle réseau. Le smoke test isolé ne remplace pas ce travail.
5. Si un budget externe est autorisé plus tard : facturation fournisseur, réservation concurrente des dépenses, rapprochement des coûts, arrêt des ressources. Une commande fund locale n’effectue aucun paiement.
6. Paiements, revenus et trading : intégrations distinctes non implémentées et non évaluées ; ne pas les présenter comme une conséquence automatique de la mémoire ou de l’orchestration.

## Commandes de validation

Utiliser Node 22.19.0 (fichier .nvmrc), puis :

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
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
