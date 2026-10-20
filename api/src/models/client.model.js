'use strict';

const mongoose = require('mongoose');

// Les clients sont alimentes par le DAG Airflow ; l'API les expose en lecture.
const clientSchema = new mongoose.Schema({
  code_client: { type: String, required: true },
  nom: String,
  prenom: String,
  email: String,
  telephone: String,
  ville: String,
  type_client: String,
  date_inscription: Date,
}, {
  collection: 'clients',
  versionKey: false,
  strict: false,
  toJSON: {
    transform(doc, ret) {
      delete ret._id;
      delete ret.etl;
      return ret;
    },
  },
});

clientSchema.index({ code_client: 1 }, { unique: true, name: 'uk_code_client' });

module.exports = mongoose.model('Client', clientSchema);
