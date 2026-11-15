# Aurora Player

Lecteur de musique pour Windows 11, construit avec **Tauri 2** (léger, ~10 Mo), design Fluent (barre de titre personnalisée, surfaces translucides, coins arrondis) et **thème adaptatif** : l'interface prend les couleurs dominantes de la pochette du morceau en cours, avec vérification de contraste et retour au neutre (clair/sombre) si la pochette est absente.

## Fonctionnalités

- **Bibliothèque** : Titres, Albums, Artistes, Playlists, Favoris, Récents
- **Scan automatique** : les dossiers choisis sont rescanés à chaque ouverture (scan incrémental) et toutes les 5 minutes pendant l'utilisation. Nouveaux morceaux ajoutés automatiquement, morceaux supprimés retirés.
- **Filtres anti-bruit** : durée minimale (60 s par défaut) et taille minimale (100 Ko par défaut), modifiables dans les Paramètres. Les fichiers écartés sont listés dans « Fichiers ignorés ».
- **Premier lancement** : le dossier « Musique » de Windows est proposé (et ajouté automatiquement si la bibliothèque est vide).
- **Lecture** : file d'attente, aléatoire, répétition, recherche globale, favoris, compteur d'écoutes, raccourcis clavier (Espace, Ctrl+Gauche/Droite).
- **Thème** : Clair / Sombre / Système + couleurs adaptatives à la pochette (désactivables).
- **Formats** : MP3, FLAC, M4A, OGG, OPUS, WAV (fichiers locaux uniquement en v1).

## Obtenir le .exe prêt à installer

1. Ouvrez l'onglet [Actions](https://github.com/chariowbusiness900-lang/aurora-player/actions).
2. Sélectionnez le workflow **Build & Release (Windows)** puis **Run workflow**. Pour une Release automatique, poussez un tag (ex. `v0.1.0`).
3. À la fin du build (10-15 min), téléchargez l'artefact **aurora-player-windows** : il contient l'installateur NSIS (`Aurora Player_0.1.0_x64-setup.exe`) et le `aurora-player.exe` portable.

## Signature (certificat auto-signé)

Le workflow signe automatiquement les binaires si deux secrets existent :

- `WINDOWS_PFX_BASE64` : le certificat PFX encodé en base64
- `WINDOWS_PFX_PASSWORD` : son mot de passe

Créez le certificat **une seule fois** (PowerShell, machine Windows) :

```powershell
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Aurora Player" -CertStoreLocation Cert:\CurrentUser\My
$pwd = ConvertTo-SecureString -String "VotreMotDePasse" -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath .\aurora.pfx -Password $pwd
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\aurora.pfx")) | Set-Clipboard
```

Puis collez le contenu du presse-papiers dans le secret `WINDOWS_PFX_BASE64` (Settings > Secrets and variables > Actions).

> Un certificat auto-signé ne supprime pas l'avertissement SmartScreen chez les autres (« Éditeur inconnu »). Pour partager l'app : code source public (ici), empreinte SHA256 publiée avec la Release (le workflow le fait), et chez l'utilisateur : clic droit sur le fichier > Propriétés > cocher « Débloquer », ou « Informations complémentaires > Exécuter quand même ». Pour une distribution publique sans avertissement, passez à Azure Trusted Signing (~10 \$/mois) ou un certificat OV/EV.

## Développement local

```bash
npm install
npm run tauri dev    # développement
npm run tauri build  # build release + installateur
```

Prérequis : Node.js 18+, Rust (stable), Visual Studio Build Tools (chargeur « Développement d'applications de bureau »). Les icônes sont régénérées avec `npx @tauri-apps/cli icon assets/icon.png` si absentes.

## Structure

- `.github/workflows/build.yml` : build, signature, Release sur tag
- `ui/` : interface (HTML/CSS/JS, design Fluent adaptatif)
- `src-tauri/` : backend Rust (scan incrémental, tags lofty, pochettes)
- `assets/icon.png` : source de l'icône

## Licence

MIT
