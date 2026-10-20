"""
Generation du jeu de donnees fictif : clients et ventes journalieres.

Les fichiers produits simulent les exports CSV des caisses d'une chaine de
distribution (separateur ';', encodage UTF-8). Des anomalies sont injectees
volontairement pour exercer les regles du DAG Airflow :

  - doublons exacts dans un meme fichier ;
  - chevauchement entre deux exports journaliers (ventes de la veille reprises) ;
  - corrections d'une vente (meme reference, date_maj plus recente) ;
  - client inconnu, quantite nulle ou non numerique, date invalide,
    champ obligatoire vide, remise hors bornes ;
  - formats heterogenes (dates JJ/MM/AAAA, montants "17 500" ou "6500,00",
    libelles de paiement et de canal non normalises).

Le generateur est deterministe (graine fixe) : deux executions produisent
exactement les memes fichiers.

Usage :
    python data/generer_donnees.py [--sortie data/source] [--jours 14]
"""

import argparse
import csv
import random
from datetime import date, datetime, timedelta
from pathlib import Path

GRAINE = 2026
DATE_DEBUT = date(2026, 10, 1)

NOMS = [
    "OUEDRAOGO", "SAWADOGO", "KABORE", "ZONGO", "TRAORE", "COMPAORE", "NIKIEMA",
    "ILBOUDO", "KONE", "SANOU", "DIALLO", "YAMEOGO", "ZOUNGRANA", "BAMOGO",
    "TIENDREBEOGO", "SOME", "DA", "PALENFO", "OUATTARA", "KINDA", "BELEM",
    "ZERBO", "KIEMA", "TAPSOBA", "GUIGMA",
]
PRENOMS = [
    "Aminata", "Issouf", "Mariam", "Boukary", "Salimata", "Adama", "Rasmata",
    "Ousmane", "Fatimata", "Seydou", "Awa", "Hamidou", "Alizeta", "Moussa",
    "Clarisse", "Inoussa", "Bibata", "Rodrigue", "Nafissatou", "Arsène",
    "Edwige", "Wendkouni", "Pascaline", "Souleymane", "Djénéba",
]
VILLES = [
    "Ouagadougou", "Ouagadougou", "Ouagadougou", "Bobo-Dioulasso",
    "Bobo-Dioulasso", "Koudougou", "Ouahigouya", "Banfora", "Kaya",
    "Tenkodogo", "Fada N'Gourma", "Dédougou",
]

PRODUITS = [
    ("PRD-001", "Riz parfumé 25 kg", "Alimentation", 17500),
    ("PRD-002", "Huile végétale 5 L", "Alimentation", 6500),
    ("PRD-003", "Sucre en poudre 1 kg", "Alimentation", 750),
    ("PRD-004", "Lait en poudre 400 g", "Alimentation", 2800),
    ("PRD-005", "Eau minérale pack 6 x 1,5 L", "Boissons", 2400),
    ("PRD-006", "Jus de bissap 1 L", "Boissons", 1000),
    ("PRD-007", "Savon de ménage carton 24", "Hygiène", 4800),
    ("PRD-008", "Détergent en poudre 1 kg", "Hygiène", 1500),
    ("PRD-009", "Ventilateur sur pied", "Électroménager", 22000),
    ("PRD-010", "Réfrigérateur 150 L", "Électroménager", 185000),
    ("PRD-011", "Smartphone Android 64 Go", "Téléphonie", 75000),
    ("PRD-012", "Carte de recharge 5000", "Téléphonie", 5000),
    ("PRD-013", "Panneau solaire 100 W", "Énergie", 45000),
    ("PRD-014", "Fer à repasser", "Électroménager", 9500),
]

# Variantes brutes telles qu'elles sortent des caisses (normalisees par l'ETL)
PAIEMENTS = {
    "ESPECES": ["ESPECES", "Espèces", "especes", "Cash"],
    "MOBILE_MONEY": ["MOBILE_MONEY", "Orange Money", "Moov Money", "mobile money"],
    "CARTE_BANCAIRE": ["CARTE_BANCAIRE", "Carte", "CB"],
    "VIREMENT": ["VIREMENT", "Virement"],
}
POIDS_PAIEMENTS = [45, 35, 12, 8]

POINTS_VENTE = {
    "OUAGA-CENTRE": "BOUTIQUE",
    "OUAGA-2000": "BOUTIQUE",
    "BOBO-DIOULASSO": "BOUTIQUE",
    "KOUDOUGOU": "BOUTIQUE",
    "WEB": "EN_LIGNE",
    "CENTRE-APPEL": "TELEPHONE",
}
CANAUX_BRUTS = {
    "BOUTIQUE": ["BOUTIQUE", "boutique", "Magasin"],
    "EN_LIGNE": ["EN_LIGNE", "en ligne", "Web"],
    "TELEPHONE": ["TELEPHONE", "Téléphone"],
}

ENTETE_CLIENTS = [
    "code_client", "nom", "prenom", "email", "telephone", "ville",
    "type_client", "date_inscription",
]
ENTETE_VENTES = [
    "reference", "date_vente", "code_client", "code_produit", "libelle_produit",
    "categorie", "quantite", "prix_unitaire", "remise_pct", "mode_paiement",
    "canal", "point_vente", "statut", "date_maj",
]


def sans_accents(texte):
    table = str.maketrans("àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ", "aaaeeeeiioouuucAAAEEEEIIOOUUUC")
    return texte.translate(table)


def generer_clients(rng, nombre=60):
    clients = []
    for i in range(1, nombre + 1):
        nom = rng.choice(NOMS)
        prenom = rng.choice(PRENOMS)
        email = f"{sans_accents(prenom).lower()}.{nom.lower()}{i}@exemple.bf"
        telephone = f"{rng.choice(['70', '71', '72', '75', '76', '65', '66', '56', '07', '51'])}{rng.randint(0, 999999):06d}"
        inscription = date(2024, 1, 1) + timedelta(days=rng.randint(0, 600))
        clients.append({
            "code_client": f"CLI-{i:04d}",
            "nom": nom,
            "prenom": prenom,
            "email": email,
            "telephone": telephone,
            "ville": rng.choice(VILLES),
            "type_client": "PROFESSIONNEL" if rng.random() < 0.2 else "PARTICULIER",
            "date_inscription": inscription.isoformat(),
        })

    # Formats heterogenes et anomalies cote clients
    clients[3]["email"] = "  " + clients[3]["email"].upper() + " "
    clients[7]["telephone"] = "+226 " + " ".join([clients[7]["telephone"][i:i + 2] for i in range(0, 8, 2)])
    clients[12]["nom"] = clients[12]["nom"].lower()
    clients[12]["prenom"] = "  " + clients[12]["prenom"].upper()
    clients[20]["ville"] = "ouagadougou"
    lignes = list(clients)
    lignes.append(dict(clients[5]))  # doublon exact
    lignes.append({  # client sans nom : rejete
        "code_client": "CLI-0061", "nom": "", "prenom": "Inconnu",
        "email": "sans.nom@exemple.bf", "telephone": "70000000",
        "ville": "Kaya", "type_client": "PARTICULIER", "date_inscription": "2025-02-10",
    })
    lignes.append({  # email invalide : rejete
        "code_client": "CLI-0062", "nom": "KABORE", "prenom": "Ali",
        "email": "ali.kabore-at-exemple.bf", "telephone": "71000000",
        "ville": "Kaya", "type_client": "PARTICULIER", "date_inscription": "2025-03-11",
    })
    return clients, lignes


def format_montant(rng, valeur):
    tirage = rng.random()
    if tirage < 0.08:
        return f"{valeur:,}".replace(",", " ")  # "17 500"
    if tirage < 0.14:
        return f"{valeur},00"  # "6500,00"
    return str(valeur)


def format_date(rng, dt):
    if rng.random() < 0.1:
        return dt.strftime("%d/%m/%Y %H:%M")
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def generer_vente(rng, jour, numero, clients):
    code, libelle, categorie, prix = rng.choice(PRODUITS)
    if prix >= 45000:
        quantite = rng.choice([1, 1, 1, 2])
    elif prix >= 5000:
        quantite = rng.randint(1, 5)
    else:
        quantite = rng.randint(1, 24)
    point_vente = rng.choices(list(POINTS_VENTE), weights=[30, 15, 20, 10, 18, 7])[0]
    canal = POINTS_VENTE[point_vente]
    paiement = rng.choices(list(PAIEMENTS), weights=POIDS_PAIEMENTS)[0]
    if canal == "EN_LIGNE" and paiement == "ESPECES":
        paiement = "MOBILE_MONEY"
    moment = datetime.combine(jour, datetime.min.time()) + timedelta(
        hours=rng.randint(8, 20), minutes=rng.randint(0, 59), seconds=rng.randint(0, 59)
    )
    remise = rng.choices([0, 0, 0, 5, 10, 15], weights=[50, 20, 10, 10, 7, 3])[0]
    return {
        "reference": f"VTE-{jour:%Y%m%d}-{numero:04d}",
        "date_vente": moment,
        "code_client": rng.choice(clients)["code_client"],
        "code_produit": code,
        "libelle_produit": libelle,
        "categorie": categorie,
        "quantite": quantite,
        "prix_unitaire": prix,
        "remise_pct": remise,
        "mode_paiement": paiement,
        "canal": canal,
        "point_vente": point_vente,
        "statut": "VALIDEE",
        "date_maj": moment + timedelta(minutes=rng.randint(1, 30)),
    }


def en_ligne_csv(rng, vente):
    """Transforme une vente propre en ligne brute telle qu'exportee par la caisse."""
    return {
        "reference": vente["reference"],
        "date_vente": format_date(rng, vente["date_vente"]),
        "code_client": vente["code_client"],
        "code_produit": vente["code_produit"],
        "libelle_produit": vente["libelle_produit"],
        "categorie": vente["categorie"] if rng.random() > 0.1 else vente["categorie"].upper(),
        "quantite": str(vente["quantite"]),
        "prix_unitaire": format_montant(rng, vente["prix_unitaire"]),
        "remise_pct": str(vente["remise_pct"]),
        "mode_paiement": rng.choice(PAIEMENTS[vente["mode_paiement"]]),
        "canal": rng.choice(CANAUX_BRUTS[vente["canal"]]),
        "point_vente": vente["point_vente"],
        "statut": vente["statut"],
        "date_maj": vente["date_maj"].strftime("%Y-%m-%d %H:%M:%S"),
    }


def injecter_anomalies(rng, jour, lignes):
    """Ajoute des lignes invalides a un export journalier."""
    anomalies = []
    base = dict(rng.choice(lignes))

    inconnu = dict(base, reference=f"VTE-{jour:%Y%m%d}-9001", code_client="CLI-9999")
    anomalies.append(inconnu)

    if jour.day % 2 == 0:
        anomalies.append(dict(base, reference=f"VTE-{jour:%Y%m%d}-9002", quantite="0"))
    else:
        anomalies.append(dict(base, reference=f"VTE-{jour:%Y%m%d}-9002", quantite="deux"))

    if jour.day % 3 == 0:
        anomalies.append(dict(base, reference=f"VTE-{jour:%Y%m%d}-9003", date_vente="2026-13-45 10:00:00"))
    if jour.day % 4 == 0:
        anomalies.append(dict(base, reference=f"VTE-{jour:%Y%m%d}-9004", code_produit=""))
    if jour.day % 5 == 0:
        anomalies.append(dict(base, reference=f"VTE-{jour:%Y%m%d}-9005", remise_pct="80"))
    if jour.day == 7:
        anomalies.append(dict(base, reference="", prix_unitaire="2500"))
    return anomalies


def generer(sortie: Path, nb_jours: int):
    rng = random.Random(GRAINE)
    sortie.mkdir(parents=True, exist_ok=True)

    clients, lignes_clients = generer_clients(rng)
    with open(sortie / "clients.csv", "w", newline="", encoding="utf-8") as f:
        ecrivain = csv.DictWriter(f, fieldnames=ENTETE_CLIENTS, delimiter=";")
        ecrivain.writeheader()
        ecrivain.writerows(lignes_clients)

    total_lignes = 0
    veille = []
    for decalage in range(nb_jours):
        jour = DATE_DEBUT + timedelta(days=decalage)
        nombre = rng.randint(40, 65)
        ventes = [generer_vente(rng, jour, n, clients) for n in range(1, nombre + 1)]

        # Quelques ventes annulees
        for vente in rng.sample(ventes, 2):
            vente["statut"] = "ANNULEE"

        lignes = [en_ligne_csv(rng, v) for v in ventes]

        # Correction : meme reference, contenu modifie, date_maj plus recente
        cible = rng.choice(ventes)
        correction = dict(cible)
        correction["quantite"] = cible["quantite"] + 1
        correction["date_maj"] = cible["date_maj"] + timedelta(hours=2)
        lignes.append(en_ligne_csv(rng, correction))

        # Doublons exacts (double envoi de ticket)
        lignes.extend(dict(l) for l in rng.sample(lignes[:nombre], 2))

        # Chevauchement : l'export reprend des ventes de la veille
        if veille:
            lignes.extend(dict(l) for l in rng.sample(veille, 4))

        lignes.extend(injecter_anomalies(rng, jour, lignes[:nombre]))
        rng.shuffle(lignes)

        nom_fichier = sortie / f"ventes_{jour:%Y-%m-%d}.csv"
        with open(nom_fichier, "w", newline="", encoding="utf-8") as f:
            ecrivain = csv.DictWriter(f, fieldnames=ENTETE_VENTES, delimiter=";")
            ecrivain.writeheader()
            ecrivain.writerows(lignes)
        total_lignes += len(lignes)
        veille = [l for l in lignes if l["reference"].startswith(f"VTE-{jour:%Y%m%d}-0")]

    print(f"{len(lignes_clients)} lignes clients, {nb_jours} fichiers de ventes, "
          f"{total_lignes} lignes de ventes ecrites dans {sortie}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sortie", default=str(Path(__file__).parent / "source"))
    parser.add_argument("--jours", type=int, default=14)
    args = parser.parse_args()
    generer(Path(args.sortie), args.jours)
