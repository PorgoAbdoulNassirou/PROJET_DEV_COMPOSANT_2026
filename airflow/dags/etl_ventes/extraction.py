"""Lecture des exports CSV deposes dans le repertoire source."""

import csv
import hashlib
from pathlib import Path

FICHIER_CLIENTS = "clients.csv"
MOTIF_VENTES = "ventes_*.csv"

COLONNES_CLIENTS = {
    "code_client", "nom", "prenom", "email", "telephone", "ville",
    "type_client", "date_inscription",
}
COLONNES_VENTES = {
    "reference", "date_vente", "code_client", "code_produit", "libelle_produit",
    "categorie", "quantite", "prix_unitaire", "remise_pct", "mode_paiement",
    "canal", "point_vente", "statut", "date_maj",
}


class FichierSourceInvalide(Exception):
    """Fichier absent, vide ou dont l'entete ne correspond pas au format attendu."""


def lister_sources(repertoire):
    """Retourne le fichier clients et la liste triee des exports de ventes."""
    racine = Path(repertoire)
    if not racine.is_dir():
        raise FichierSourceInvalide(f"Repertoire source introuvable : {racine}")
    clients = racine / FICHIER_CLIENTS
    if not clients.is_file():
        raise FichierSourceInvalide(f"Fichier {FICHIER_CLIENTS} absent de {racine}")
    ventes = sorted(racine.glob(MOTIF_VENTES))
    if not ventes:
        raise FichierSourceInvalide(f"Aucun fichier {MOTIF_VENTES} dans {racine}")
    return clients, ventes


def empreinte_fichier(chemin):
    sha = hashlib.sha256()
    with open(chemin, "rb") as f:
        for bloc in iter(lambda: f.read(65536), b""):
            sha.update(bloc)
    return sha.hexdigest()


def lire_csv(chemin, colonnes_attendues):
    """
    Lit un CSV ';' en UTF-8 (BOM toleree) et retourne la liste des lignes.

    Chaque ligne est enrichie de son origine (_fichier, _ligne) pour la
    tracabilite des rejets. Le numero de ligne est celui du fichier (entete = 1).
    """
    chemin = Path(chemin)
    with open(chemin, newline="", encoding="utf-8-sig") as f:
        lecteur = csv.DictReader(f, delimiter=";")
        entete = set(lecteur.fieldnames or [])
        manquantes = colonnes_attendues - entete
        if manquantes:
            raise FichierSourceInvalide(
                f"{chemin.name} : colonnes manquantes {sorted(manquantes)}"
            )
        lignes = []
        for numero, ligne in enumerate(lecteur, start=2):
            if not any((v or "").strip() for k, v in ligne.items() if k):
                continue  # ligne vide
            propre = {k: (v if v is not None else "") for k, v in ligne.items() if k in colonnes_attendues}
            propre["_fichier"] = chemin.name
            propre["_ligne"] = numero
            lignes.append(propre)
    return lignes
