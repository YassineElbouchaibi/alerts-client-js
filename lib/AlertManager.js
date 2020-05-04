const array = require('@barchart/common-js/lang/array'),
	assert = require('@barchart/common-js/lang/assert'),
	is = require('@barchart/common-js/lang/is'),
	Disposable = require('@barchart/common-js/lang/Disposable'),
	Event = require('@barchart/common-js/messaging/Event'),
	promise = require('@barchart/common-js/lang/promise');

const SearchManager = require('@barchart/instruments-client-js/lib/search/SearchManager');

const convertBaseCodeToUnitCode = require('@barchart/marketdata-api-js/lib/utilities/convert/baseCodeToUnitCode'),
	formatPrice = require('@barchart/marketdata-api-js/lib/utilities/format/price'),
	valueParser = require('@barchart/marketdata-api-js/lib/utilities/parse/ddf/value');

const validate = require('./data/validators/validate');

const AdapterBase = require('./adapters/AdapterBase'),
	JwtProvider = require('./security/JwtProvider');

const version = require('./meta').version;

module.exports = (() => {
	'use strict';

	const regex = { };

	regex.hosts = { };
	regex.hosts.production = /(prod)/i;

	/**
	 * The entry point for interacting with the Barchart's Alert Service.
	 *
	 * @public
	 * @exported
	 * @extends {Disposable}
	 * @param {String} host - The host name of Barchart's Alert Service.
	 * @param {Number} port - The TCP port used to connect to the Alert Service.
	 * @param {Boolean} secure - If true, the transport layer will use encryption (e.g. HTTPS, WSS, etc).
	 * @param {Function} adapterClazz - The constructor (function) for a class extending {@link AdapterBase}. This defines the transport strategy.
	 */
	class AlertManager extends Disposable {
		constructor(host, port, secure, adapterClazz) {
			super();

			assert.argumentIsRequired(host, 'host', String);
			assert.argumentIsRequired(port, 'port', Number);
			assert.argumentIsRequired(secure, 'secure', Boolean);
			assert.argumentIsRequired(adapterClazz, 'adapterClazz', Function);

			if (!is.extension(AdapterBase, adapterClazz)) {
				throw new Error('The "adapterClazz" argument must be the constructor for a class which extends AdapterBase.');
			}

			this._host = host;
			this._port = port;
			this._secure = secure;

			this._adapter = null;
			this._adapterClazz = adapterClazz;

			this._connectPromise = null;

			this._searchManager = null;

			this._alertSubscriptionMap = { };
		}

		/**
		 * Establishes a connection to Barchart's Alert Service. Invoke this function (and wait for
		 * the resulting promise to resolve) before attempting to use other instance functions.
		 *
		 * @public
		 * @param {JwtProvider} jwtProvider - An implementation of {@link JwtProvider} used to supply JWT tokens.
		 * @returns {Promise<AlertManager>}
		 */
		connect(jwtProvider) {
			return Promise.resolve()
				.then(() => {
					assert.argumentIsRequired(jwtProvider, 'jwtProvider', JwtProvider, 'JwtProvider');

					checkDispose(this, 'connect');
				}).then(() => {
					if (this._connectPromise === null) {
						const alertAdapterPromise = Promise.resolve()
							.then(() => {
								const AdapterClazz = this._adapterClazz;
								const adapter = new AdapterClazz(this._host, this._port, this._secure, onAlertCreated.bind(this), onAlertMutated.bind(this), onAlertDeleted.bind(this), onAlertTriggered.bind(this));

								return timeout(adapter.connect(jwtProvider), 10000, 'Alert service is temporarily unavailable. Please try again later.');
							});

						const searchManagerPromise = Promise.resolve()
							.then(() => {
								let host;

								if (regex.hosts.production.test(this._host)) {
									host = 'instruments-prod.aws.barchart.com';
								} else {
									host = 'instruments-stage.aws.barchart.com';
								}

								const manager = new SearchManager(host, 443, 'rest', true);

								return timeout(manager.connect(), 10000, 'Search service is temporarily unavailable. Please try again later.');
							});

						this._connectPromise = Promise.all([alertAdapterPromise, searchManagerPromise])
							.then((results) => {
								this._adapter = results[0];
								this._searchManager = results[1];

								return this;
							}).catch((e) => {
								this._connectPromise = null;

								throw e;
							});
					}

					return this._connectPromise;
				});
		}

		/**
		 * Checks to ensure a instrument's symbol is valid and the instrument
		 * has not been marked as expired. In some cases a different symbol
		 * will be returned. When this happens the alternate symbol should be
		 * used.
		 *
		 * @public
		 * @param {String} symbol - The symbol to check
		 * @returns {Promise<String>}
		 */
		checkSymbol(symbol) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'check symbol');

					return this._searchManager.lookupInstrument(symbol);
				}).then((result) => {
					validate.instrument.forCreate(symbol, result.instrument);

					return result.instrument.symbol;
				});
		}

		/**
		 *
		 * @param alert
		 * @returns {Promise<any[]>}
		 */
		createAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'create alert');

					validate.alert.forCreate(alert);
				}).then(() => {
					return Promise.all([
						this.getProperties(),
						this.getOperators()
					]);
				}).then((results) => {
					const properties = results[0];
					const operators = results[1];

					const propertyMap = alert.conditions.reduce((map, c) => {
						const property = properties.find((p) => p.property_id === c.property.property_id);

						map[property.property_id] = property;

						return map;
					}, { });

					const operatorMap = alert.conditions.reduce((map, c) => {
						const operator = operators.find((o) => o.operator_id === c.operator.operator_id);

						map[operator.operator_id] = operator;

						return map;
					}, { });

					const instrumentMap = alert.conditions.reduce((map, c) => {
						const property = propertyMap[c.property.property_id];

						if (property.target.type === 'symbol') {
							const symbol = c.property.target.identifier;

							if (!map.hasOwnProperty(symbol)) {
								map[symbol] = this._searchManager.lookupInstrument(symbol);
							}
						}

						return map;
					}, { });

					return Promise.all(alert.conditions.map((c, i) => {
						let validatePromise;

						const property = propertyMap[c.property.property_id];
						const operator = operatorMap[c.operator.operator_id];

						if (property.target.type === 'symbol') {
							const symbol = c.property.target.identifier;

							validatePromise = instrumentMap[symbol]
								.then((result) => {
									const instrument = result.instrument;
									const unitcode = convertBaseCodeToUnitCode(instrument.unitcode);

									validate.instrument.forCreate(symbol, instrument);

									if (property.format === 'price' && operator.operand_type === 'number' && operator.operand_literal) {
										let operandToParse = c.operator.operand;

										if (is.string(operandToParse) && operandToParse.match(/^(-?)([0-9,]+)$/) !== null) {
											operandToParse = operandToParse + '.0';
										}

										const price = valueParser(operandToParse, unitcode, ',');

										if (!is.number(price)) {
											throw new Error('Condition ' + i + ' is invalid. The price cannot be parsed.');
										}

										c.operator.operand_display = c.operator.operand;
										c.operator.operand_format = formatPrice(price, unitcode, '-', false, ',');
										c.operator.operand = price;
									}
								});
						} else {
							validatePromise = Promise.resolve();
						}

						return validatePromise;
					}));
				}).then(() => {
					return this._adapter.createAlert(alert);
				});
		}

		retrieveAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'retrieve alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					return this._adapter.retrieveAlert(alert);
				});
		}

		editAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'edit alert');

					validate.alert.forEdit(alert);
				}).then(() => {
					return this.deleteAlert(alert);
				}).then(() => {
					return this.createAlert(alert);
				});
		}

		enableAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'enable alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					const clone = Object.assign(alert);
					clone.alert_state = 'Starting';

					onAlertMutated.call(this, clone);

					return this._adapter.updateAlert({alert_id: alert.alert_id, alert_state: 'Starting'});
				});
		}

		enableAlerts(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'enable alerts');

					validate.alert.forUser(query);

					return this._adapter.updateAlertsForUser({user_id: query.user_id, alert_system: query.alert_system, alert_state: 'Starting'});
				}).then(() => {
					return true;
				});
		}

		disableAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'disable alert');

					validate.alert.forQuery(alert);
				}).then(() => {
					const clone = Object.assign(alert);
					clone.alert_state = 'Stopping';

					onAlertMutated.call(this, clone);

					return this._adapter.updateAlert({alert_id: alert.alert_id, alert_state: 'Stopping'});
				});
		}

		disableAlerts(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'disable alerts');

					validate.alert.forUser(query);

					return this._adapter.updateAlertsForUser({user_id: query.user_id, alert_system: query.alert_system, alert_state: 'Stopping'});
				}).then(() => {
					return true;
				});
		}

		deleteAlert(alert) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'delete alert');

					validate.alert.forQuery(alert);
				}).then(() => {

				}).then(() => {
					return this._adapter.deleteAlert({alert_id: alert.alert_id});
				});
		}

		retrieveAlerts(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'retrieve alerts');

					validate.alert.forUser(query);
				}).then(() => {
					return this._adapter.retrieveAlerts(query);
				}).then((results) => {
					if (query.filter && query.filter.alert_type) {
						return results.filter((result) => result.alert_type === query.filter.alert_type);
					} else {
						return results;
					}
				}).then((results) => {
					if (query.filter && query.filter.symbol) {
						return results.filter((result) => result.conditions.some((c) => (c.property.target.type === 'symbol' && c.property.target.identifier ===  query.filter.symbol) || (c.property.type === 'symbol' && c.operator.operand === query.filter.symbol)));
					} else {
						return results;
					}
				}).then((results) => {
					if (query.filter && query.filter.target && query.filter.target.identifier) {
						return results.filter((result) => result.conditions.some((c) => c.property.target.identifier === query.filter.target.identifier));
					} else {
						return results;
					}
				}).then((results) => {
					if (query.filter && query.filter.condition && (typeof(query.filter.condition.operand) === 'string' || typeof(query.filter.condition.operand) === 'number')) {
						return results.filter((result) => result.conditions.some((c) => c.operator.operand === query.filter.condition.operand.toString()));
					} else {
						return results;
					}
				});
		}

		subscribeAlerts(query, changeCallback, deleteCallback, createCallback, triggerCallback) {
			checkStatus(this, 'subscribe alerts');

			validate.alert.forUser(query);

			assert.argumentIsRequired(changeCallback, 'changeCallback', Function);
			assert.argumentIsRequired(deleteCallback, 'deleteCallback', Function);
			assert.argumentIsRequired(createCallback, 'createCallback', Function);
			assert.argumentIsRequired(triggerCallback, 'triggerCallback', Function);

			const userId = query.user_id;
			const alertSystem = query.alert_system;

			if (!this._alertSubscriptionMap.hasOwnProperty(userId)) {
				this._alertSubscriptionMap[userId] = {};
			}

			if (!this._alertSubscriptionMap[userId].hasOwnProperty(alertSystem)) {
				this._alertSubscriptionMap[userId][alertSystem] = {
					createEvent: new Event(this),
					changeEvent: new Event(this),
					deleteEvent: new Event(this),
					triggerEvent: new Event(this),
					subscribers: 0
				};
			}

			const subscriptionData = this._alertSubscriptionMap[userId][alertSystem];

			if (subscriptionData.subscribers === 0) {
				subscriptionData.implementationBinding = this._adapter.subscribeAlerts(query);
			}

			subscriptionData.subscribers = subscriptionData.subscribers + 1;

			const createRegistration = subscriptionData.createEvent.register(createCallback);
			const changeRegistration = subscriptionData.changeEvent.register(changeCallback);
			const deleteRegistration = subscriptionData.deleteEvent.register(deleteCallback);
			const triggerRegistration = subscriptionData.triggerEvent.register(triggerCallback);

			return Disposable.fromAction(() => {
				subscriptionData.subscribers = subscriptionData.subscribers - 1;

				if (subscriptionData.subscribers === 0) {
					subscriptionData.implementationBinding.dispose();
				}

				createRegistration.dispose();
				changeRegistration.dispose();
				deleteRegistration.dispose();
				triggerRegistration.dispose();
			});
		}

		getTargets() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get targets');

					return this._adapter.getTargets();
				});
		}

		getProperties() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get properties');

					return this._adapter.getProperties();
				});
		}

		getOperators() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get operators');

					return this._adapter.getOperators();
				});
		}

		getModifiers() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get modifiers');

					return this._adapter.getModifiers();
				});
		}

		getPublisherTypes() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get publisher types');

					return this._adapter.getPublisherTypes();
				});
		}

		getPublisherTypeDefaults(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get publisher type defaults');

					validate.publisherTypeDefault.forUser(query);
				}).then(() => {
					return this._adapter.getPublisherTypeDefaults(query);
				});
		}

		assignPublisherTypeDefault(publisherTypeDefault) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'assign publisher type default');

					validate.publisherTypeDefault.forCreate(publisherTypeDefault);
				}).then(() => {
					return this._adapter.assignPublisherTypeDefault(publisherTypeDefault);
				});
		}

		getMarketDataConfiguration(query) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get market data configuration');
				}).then(() => {
					return this._adapter.getMarketDataConfiguration(query);
				});
		}

		assignMarketDataConfiguration(marketDataConfiguration) {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'assign market data configuration');
				}).then(() => {
					return this._adapter.assignMarketDataConfiguration(marketDataConfiguration);
				});
		}

		getServerVersion() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get server version');
				}).then(() => {
					return this._adapter.getServerVersion();
				});
		}

		getUser() {
			return Promise.resolve()
				.then(() => {
					checkStatus(this, 'get authenticated user');
				}).then(() => {
					return this._adapter.getUser();
				});
		}

		static getPropertiesForTarget(properties, target) {
			return properties.filter((property) => property.target.target_id === target.target_id);
		}

		static getOperatorsForProperty(operators, property) {
			const operatorMap = AlertManager.getOperatorMap(operators);

			return property.valid_operators.map((operatorId) => operatorMap[operatorId]);
		}

		static getPropertyTree(properties, short) {
			let descriptionSelector;

			if (is.boolean(short) && short) {
				descriptionSelector = p => p.descriptionShort;
			} else {
				descriptionSelector = p => p.description;
			}

			const root = properties.reduce((tree, property) => {
				const descriptionPath = (property.category || [ ]).concat(descriptionSelector(property) || [ ]);
				const descriptionPathLast = descriptionPath.length - 1;

				let node = tree;

				descriptionPath.forEach((description, i) => {
					node.items = node.items || [ ];

					let child = node.items.find((candidate) => candidate.description === description);

					if (!child) {
						let sortOrder;

						if (i === descriptionPathLast && typeof(property.sortOrder) === 'number') {
							sortOrder = property.sortOrder;
						} else {
							sortOrder = property.sortOrder;
						}

						child = {
							description: description,
							sortOrder: sortOrder
						};

						node.items.push(child);
					}

					node = child;
				});

				node.item = property;

				return tree;
			}, { });

			const sortTree = (node) => {
				if (!Array.isArray(node.items)) {
					return;
				}

				node.items.sort((a, b) => {
					let returnVal = a.sortOrder - b.sortOrder;

					if (returnVal === 0) {
						returnVal = a.description.localeCompare(b.description);
					}

					return returnVal;
				});

				node.items.forEach((child) => {
					sortTree(child);
				});
			};

			sortTree(root);

			return root.items;
		}

		static getPropertyMap(properties) {
			return array.indexBy(properties, (property) => property.property_id);
		}

		static getOperatorMap(operators) {
			return array.indexBy(operators, (operator) => operator.operator_id);
		}

		/**
		 * Returns the version of the SDK.
		 *
		 * @public
		 * @static
		 * @returns {String}
		 */
		static version() {
			return version;
		}

		_onDispose() {
			if (this._adapter) {
				this._adapter.dispose();
				this._adapter = null;
			}

			if (this._searchManager) {
				this._searchManager.dispose();
				this._searchManager = null;
			}

			this._alertSubscriptionMap = null;
		}

		toString() {
			return '[AlertManager]';
		}
	}

	function getMutationEvents(map, alert) {
		let returnRef = null;

		const userId = alert.user_id;
		const alertSystem = alert.alert_system;

		if (map.hasOwnProperty(userId)) {
			const systemMap = map[userId];

			if (systemMap.hasOwnProperty(alertSystem)) {
				returnRef = systemMap[alertSystem];
			}
		}

		return returnRef;
	}

	function checkDispose(manager, operation) {
		if (manager.getIsDisposed()) {
			throw new Error(`Unable to perform ${operation}, the alert manager has been disposed`);
		}
	}

	function checkStatus(manager, operation) {
		checkDispose(manager, operation);

		if (manager._adapter === null) {
			throw new Error(`Unable to perform ${operation}, the alert manager has not connected to the server`);
		}
	}

	function onAlertCreated(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, alert);

		if (data) {
			data.createEvent.fire(Object.assign(alert));
		}
	}

	function onAlertMutated(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, alert);

		if (data) {
			data.changeEvent.fire(Object.assign(alert));
		}
	}

	function onAlertDeleted(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, alert);

		if (data) {
			data.deleteEvent.fire(alert);
		}
	}

	function onAlertTriggered(alert) {
		if (!alert) {
			return;
		}

		const data = getMutationEvents(this._alertSubscriptionMap, alert);

		if (data) {
			data.triggerEvent.fire(alert);
		}
	}

	function timeout(p, duration, description) {
		return Promise.race([
			p, promise.build((resolveCallback, rejectCallback) => {
				setTimeout(() => {
					rejectCallback(description);
				}, duration);
			})
		]);
	}

	return AlertManager;
})();