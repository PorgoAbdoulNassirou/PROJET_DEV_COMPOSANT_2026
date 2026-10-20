'use strict';

const mongoose = require('mongoose');

// Collections ecrites par le DAG ventes_etl, exposees en lecture seule.
const options = {
  versionKey: false,
  strict: false,
  strictQuery: false,
  toJSON: {
    transform(doc, ret) {
      delete ret._id;
      return ret;
    },
  },
};

const ExecutionEtl = mongoose.model('ExecutionEtl', new mongoose.Schema({}, { ...options, collection: 'etl_executions' }));
const RejetEtl = mongoose.model('RejetEtl', new mongoose.Schema({}, { ...options, collection: 'ventes_rejets' }));

module.exports = { ExecutionEtl, RejetEtl };
