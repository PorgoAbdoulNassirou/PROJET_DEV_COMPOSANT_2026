'use strict';

// Journalisation structuree (une ligne JSON par evenement).
// Les lignes ecrites dans LOG_FILE sont collectees par Filebeat puis
// acheminees vers Logstash et Elasticsearch.

const path = require('path');
const fs = require('fs');
const winston = require('winston');
const config = require('./index');

const formatJson = winston.format.combine(
  winston.format.timestamp({ alias: '@timestamp' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const transports = [];

if (config.log.console) {
  transports.push(new winston.transports.Console({
    format: config.env === 'development'
      ? winston.format.combine(winston.format.colorize(), winston.format.simple())
      : formatJson,
  }));
}

if (config.log.fichier) {
  fs.mkdirSync(path.dirname(config.log.fichier), { recursive: true });
  transports.push(new winston.transports.File({
    filename: config.log.fichier,
    format: formatJson,
    maxsize: 10 * 1024 * 1024,
    maxFiles: 5,
    tailable: true,
  }));
}

const logger = winston.createLogger({
  level: config.log.niveau,
  defaultMeta: { service: 'api-ventes', environnement: config.env },
  transports,
  silent: transports.length === 0,
});

module.exports = logger;
