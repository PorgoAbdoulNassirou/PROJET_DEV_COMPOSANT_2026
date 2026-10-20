import os
import sys

# Rend le paquet etl_ventes importable comme dans Airflow (dossier dags sur le PYTHONPATH).
DAGS = os.environ.get("AIRFLOW__CORE__DAGS_FOLDER", os.path.join(os.path.dirname(__file__), "..", "dags"))
sys.path.insert(0, os.path.abspath(DAGS))
