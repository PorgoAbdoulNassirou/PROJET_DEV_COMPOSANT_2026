"""
Regles de controle et de normalisation des clients et des ventes.

Toutes les fonctions de ce module sont pures (aucun acces reseau ni base de
donnees) afin d'etre testees unitairement en dehors d'Airflow.

Convention : une fonction de normalisation retourne un couple (document, motifs).
Si la liste des motifs n'est pas vide, la ligne est rejetee et le document vaut None.
"""

import hashlib
import json
import re
import unicodedata
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

RE_CODE_CLIENT = re.compile(r"^CLI-\d{4}$")
RE_REFERENCE = re.compile(r"^VTE-\d{8}-[A-Z0-9]{4,10}$")
RE_CODE_PRODUIT = re.compile(r"^PRD-\d{3}$")
RE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$")

QUANTITE_MAX = 1000
PRIX_MAX = 10_000_000
REMISE_MAX = 50
DEVISE = "XOF"

FORMATS_DATE_HEURE = (
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S",
    "%d/%m/%Y %H:%M:%S",
    "%d/%m/%Y %H:%M",
    "%Y-%m-%d",
    "%d/%m/%Y",
)

MODES_PAIEMENT = {
    "ESPECES": "ESPECES",
    "CASH": "ESPECES",
    "MOBILE_MONEY": "MOBILE_MONEY",
    "ORANGE_MONEY": "MOBILE_MONEY",
    "MOOV_MONEY": "MOBILE_MONEY",
    "CARTE_BANCAIRE": "CARTE_BANCAIRE",
    "CARTE": "CARTE_BANCAIRE",
    "CB": "CARTE_BANCAIRE",
    "VIREMENT": "VIREMENT",
}
CANAUX = {
    "BOUTIQUE": "BOUTIQUE",
    "MAGASIN": "BOUTIQUE",
    "EN_LIGNE": "EN_LIGNE",
    "WEB": "EN_LIGNE",
    "INTERNET": "EN_LIGNE",
    "TELEPHONE": "TELEPHONE",
}
STATUTS = {"VALIDEE": "VALIDEE", "ANNULEE": "ANNULEE"}
CATEGORIES = {
    "ALIMENTATION": "Alimentation",
    "BOISSONS": "Boissons",
    "HYGIENE": "Hygiène",
    "ELECTROMENAGER": "Électroménager",
    "TELEPHONIE": "Téléphonie",
    "ENERGIE": "Énergie",
}
TYPES_CLIENT = {"PARTICULIER", "PROFESSIONNEL"}


# --------------------------------------------------------------------------
# Utilitaires de normalisation
# --------------------------------------------------------------------------

def texte(valeur):
    """Supprime les espaces superflus ; retourne une chaine vide pour None."""
    return " ".join(str(valeur or "").split())


def cle(valeur):
    """Cle de rapprochement : majuscules, sans accents, separateurs '_'."""
    sans_accent = unicodedata.normalize("NFKD", texte(valeur))
    sans_accent = "".join(c for c in sans_accent if not unicodedata.combining(c))
    return re.sub(r"[\s\-]+", "_", sans_accent.upper())


def nom_propre(valeur):
    """Met en forme un prenom ou une ville saisi entierement en minuscules ou majuscules."""
    valeur = texte(valeur)
    if valeur and (valeur.islower() or valeur.isupper()):
        return valeur.title()
    return valeur


def lire_nombre(valeur):
    """Convertit '17 500', '6500,00' ou '6500' en Decimal ; None si illisible."""
    brut = str(valeur or "").replace(" ", "").replace(" ", "").replace(" ", "")
    brut = brut.replace(",", ".")
    if not brut:
        return None
    try:
        return Decimal(brut)
    except InvalidOperation:
        return None


def lire_date(valeur):
    valeur = texte(valeur)
    for fmt in FORMATS_DATE_HEURE:
        try:
            return datetime.strptime(valeur, fmt)
        except ValueError:
            continue
    return None


def empreinte(document):
    """Empreinte SHA-256 du contenu metier, independante de l'ordre des cles."""
    contenu = json.dumps(document, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(contenu.encode("utf-8")).hexdigest()


def motif(code, champ, message):
    return {"code": code, "champ": champ, "message": message}


# --------------------------------------------------------------------------
# Clients
# --------------------------------------------------------------------------

def normaliser_telephone(valeur):
    chiffres = re.sub(r"\D", "", str(valeur or ""))
    if chiffres.startswith("00226"):
        chiffres = chiffres[5:]
    elif chiffres.startswith("226") and len(chiffres) == 11:
        chiffres = chiffres[3:]
    if len(chiffres) != 8:
        return None
    return f"+226{chiffres}"


def normaliser_client(ligne):
    motifs = []
    code = texte(ligne.get("code_client")).upper()
    nom = texte(ligne.get("nom")).upper()
    prenom = nom_propre(ligne.get("prenom"))
    email = texte(ligne.get("email")).lower()
    telephone_brut = texte(ligne.get("telephone"))
    type_client = cle(ligne.get("type_client")) or "PARTICULIER"
    inscription_brute = texte(ligne.get("date_inscription"))

    if not code:
        motifs.append(motif("CHAMP_OBLIGATOIRE", "code_client", "code client absent"))
    elif not RE_CODE_CLIENT.match(code):
        motifs.append(motif("FORMAT_CODE_CLIENT", "code_client", f"format attendu CLI-0000, recu '{code}'"))
    if not nom:
        motifs.append(motif("CHAMP_OBLIGATOIRE", "nom", "nom absent"))
    if not prenom:
        motifs.append(motif("CHAMP_OBLIGATOIRE", "prenom", "prenom absent"))
    if email and not RE_EMAIL.match(email):
        motifs.append(motif("EMAIL_INVALIDE", "email", f"adresse '{email}' invalide"))

    telephone = None
    if telephone_brut:
        telephone = normaliser_telephone(telephone_brut)
        if telephone is None:
            motifs.append(motif("TELEPHONE_INVALIDE", "telephone", f"numero '{telephone_brut}' invalide"))

    if type_client not in TYPES_CLIENT:
        motifs.append(motif("TYPE_CLIENT_INCONNU", "type_client", f"valeur '{type_client}' inconnue"))

    inscription = None
    if inscription_brute:
        date_lue = lire_date(inscription_brute)
        if date_lue is None:
            motifs.append(motif("DATE_INVALIDE", "date_inscription", f"date '{inscription_brute}' illisible"))
        else:
            inscription = date_lue.date().isoformat()

    if motifs:
        return None, motifs

    document = {
        "code_client": code,
        "nom": nom,
        "prenom": prenom,
        "email": email or None,
        "telephone": telephone,
        "ville": nom_propre(ligne.get("ville")) or None,
        "type_client": type_client,
        "date_inscription": inscription,
    }
    document["hash"] = empreinte(document)
    return document, []


# --------------------------------------------------------------------------
# Ventes
# --------------------------------------------------------------------------

def calculer_montants(quantite, prix_unitaire, remise_pct):
    """Montants en francs CFA, arrondis a l'unite (le XOF n'a pas de centimes)."""
    brut = quantite * prix_unitaire
    remise = int((Decimal(brut) * Decimal(remise_pct) / Decimal(100)).quantize(Decimal("1"), rounding="ROUND_HALF_UP"))
    return brut, remise, brut - remise


def normaliser_vente(ligne, clients_connus, maintenant=None):
    """
    Controle et normalise une ligne d'export de caisse.

    clients_connus : ensemble des codes clients presents dans le referentiel.
    maintenant     : date de reference pour le controle des dates futures.
    """
    maintenant = maintenant or datetime.now()
    motifs = []

    reference = texte(ligne.get("reference")).upper()
    code_client = texte(ligne.get("code_client")).upper()
    code_produit = texte(ligne.get("code_produit")).upper()
    libelle = texte(ligne.get("libelle_produit"))

    for champ, valeur in (
        ("reference", reference),
        ("code_client", code_client),
        ("code_produit", code_produit),
        ("libelle_produit", libelle),
    ):
        if not valeur:
            motifs.append(motif("CHAMP_OBLIGATOIRE", champ, f"{champ} absent"))

    if reference and not RE_REFERENCE.match(reference):
        motifs.append(motif("FORMAT_REFERENCE", "reference", f"format attendu VTE-AAAAMMJJ-XXXX, recu '{reference}'"))
    if code_produit and not RE_CODE_PRODUIT.match(code_produit):
        motifs.append(motif("FORMAT_CODE_PRODUIT", "code_produit", f"format attendu PRD-000, recu '{code_produit}'"))
    if code_client and code_client not in clients_connus:
        motifs.append(motif("CLIENT_INCONNU", "code_client", f"client '{code_client}' absent du referentiel"))

    date_vente = lire_date(ligne.get("date_vente"))
    if date_vente is None:
        motifs.append(motif("DATE_INVALIDE", "date_vente", f"date '{texte(ligne.get('date_vente'))}' illisible"))
    elif date_vente > maintenant + timedelta(days=1):
        motifs.append(motif("DATE_FUTURE", "date_vente", f"date {date_vente:%Y-%m-%d} posterieure a la date de traitement"))

    date_maj = lire_date(ligne.get("date_maj")) or date_vente

    quantite = lire_nombre(ligne.get("quantite"))
    if quantite is None or quantite != quantite.to_integral_value() or not (1 <= quantite <= QUANTITE_MAX):
        motifs.append(motif("QUANTITE_INVALIDE", "quantite",
                            f"entier entre 1 et {QUANTITE_MAX} attendu, recu '{texte(ligne.get('quantite'))}'"))

    prix = lire_nombre(ligne.get("prix_unitaire"))
    if prix is None or prix != prix.to_integral_value() or not (0 < prix <= PRIX_MAX):
        motifs.append(motif("PRIX_INVALIDE", "prix_unitaire",
                            f"montant entier positif attendu, recu '{texte(ligne.get('prix_unitaire'))}'"))

    remise = lire_nombre(ligne.get("remise_pct") or "0")
    if remise is None or not (0 <= remise <= REMISE_MAX):
        motifs.append(motif("REMISE_INVALIDE", "remise_pct",
                            f"pourcentage entre 0 et {REMISE_MAX} attendu, recu '{texte(ligne.get('remise_pct'))}'"))

    mode_paiement = MODES_PAIEMENT.get(cle(ligne.get("mode_paiement")))
    if mode_paiement is None:
        motifs.append(motif("MODE_PAIEMENT_INCONNU", "mode_paiement", f"valeur '{texte(ligne.get('mode_paiement'))}' inconnue"))
    canal = CANAUX.get(cle(ligne.get("canal")))
    if canal is None:
        motifs.append(motif("CANAL_INCONNU", "canal", f"valeur '{texte(ligne.get('canal'))}' inconnue"))
    statut = STATUTS.get(cle(ligne.get("statut")) or "VALIDEE")
    if statut is None:
        motifs.append(motif("STATUT_INCONNU", "statut", f"valeur '{texte(ligne.get('statut'))}' inconnue"))

    if motifs:
        return None, motifs

    quantite, prix, remise = int(quantite), int(prix), float(remise)
    if remise.is_integer():
        remise = int(remise)
    brut, montant_remise, net = calculer_montants(quantite, prix, remise)
    categorie_brute = texte(ligne.get("categorie"))

    document = {
        "reference": reference,
        "date_vente": date_vente.isoformat(),
        "code_client": code_client,
        "produit": {
            "code": code_produit,
            "libelle": libelle,
            "categorie": CATEGORIES.get(cle(categorie_brute), categorie_brute or "Autre"),
        },
        "quantite": quantite,
        "prix_unitaire": prix,
        "remise_pct": remise,
        "montant_brut": brut,
        "montant_remise": montant_remise,
        "montant_net": net,
        "devise": DEVISE,
        "mode_paiement": mode_paiement,
        "canal": canal,
        "point_vente": texte(ligne.get("point_vente")).upper() or None,
        "statut": statut,
    }
    # L'empreinte porte uniquement sur le contenu metier : une ligne re-exportee
    # avec une nouvelle date_maj mais un contenu identique reste "inchangee".
    document["hash"] = empreinte(document)
    document["date_maj"] = date_maj.isoformat()
    document["origine"] = {"fichier": ligne.get("_fichier"), "ligne": ligne.get("_ligne")}
    return document, []


def dedoublonner(documents, cle_metier, cle_tri=None):
    """
    Conserve une seule version par cle metier.

    La version retenue est la plus recente selon cle_tri (date_maj pour les
    ventes), puis le fichier le plus recent, puis la ligne la plus basse.
    Les autres versions sont classees en :
      - DOUBLON_EXACT     : meme contenu que la version retenue ;
      - VERSION_OBSOLETE  : contenu different, remplace par une version plus recente.
    """
    groupes = {}
    for doc in documents:
        groupes.setdefault(doc[cle_metier], []).append(doc)

    retenus, ecartes = [], []
    for versions in groupes.values():
        versions.sort(
            key=lambda d: (
                d.get(cle_tri) or "" if cle_tri else "",
                (d.get("origine") or {}).get("fichier") or "",
                (d.get("origine") or {}).get("ligne") or 0,
            ),
            reverse=True,
        )
        gagnant = versions[0]
        retenus.append(gagnant)
        for autre in versions[1:]:
            code = "DOUBLON_EXACT" if autre["hash"] == gagnant["hash"] else "VERSION_OBSOLETE"
            ecartes.append((autre, code))
    retenus.sort(key=lambda d: d[cle_metier])
    return retenus, ecartes


def transformer_clients(lignes):
    """Retourne (clients_valides, rejets, doublons)."""
    valides, rejets = [], []
    for ligne in lignes:
        doc, motifs = normaliser_client(ligne)
        if motifs:
            rejets.append({"ligne": ligne, "motifs": motifs})
        else:
            doc["origine"] = {"fichier": ligne.get("_fichier"), "ligne": ligne.get("_ligne")}
            valides.append(doc)
    retenus, ecartes = dedoublonner(valides, "code_client")
    return retenus, rejets, ecartes


def transformer_ventes(lignes, clients_connus, maintenant=None):
    """Retourne (ventes_valides, rejets, doublons)."""
    valides, rejets = [], []
    for ligne in lignes:
        doc, motifs = normaliser_vente(ligne, clients_connus, maintenant)
        if motifs:
            rejets.append({"ligne": ligne, "motifs": motifs})
        else:
            valides.append(doc)
    retenus, ecartes = dedoublonner(valides, "reference", cle_tri="date_maj")
    return retenus, rejets, ecartes
