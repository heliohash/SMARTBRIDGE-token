'use strict';

var async = require('async');
var crypto = require('crypto');
var extend = require('extend');
var genesisblock = null;
var Router = require('../helpers/router.js');
var schema = require('../schema/multisignatures.js');
var slots = require('../helpers/slots.js');
var sql = require('../sql/multisignatures.js');
var Multisignature = require('../logic/multisignature.js');
var transactionTypes = require('../helpers/transactionTypes.js');

// Private fields
// TODO: to be removed
var modules, library, self, __private = {}, shared = {};

__private.assetTypes = {};

// Constructor
function Multisignatures (cb, scope) {
	library = scope;
	genesisblock = library.genesisblock;
	self = this;


	__private.assetTypes[transactionTypes.MULTI] = library.logic.transaction.attachAssetType(
		transactionTypes.MULTI, new Multisignature()
	);

	setImmediate(cb, null, self);
}

// Private methods
__private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) { return next(); }
		res.status(500).send({success: false, error: 'Blockchain is loading'});
	});

	router.map(shared, {
		'get /pending': 'pending',
		'post /sign': 'sign',
		'put /': 'addMultisignature',
		'get /accounts': 'getAccounts'
	});

	router.use(function (req, res, next) {
		res.status(500).send({success: false, error: 'API endpoint not found'});
	});

	library.network.app.use('/api/multisignatures', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) { return next(); }
		library.logger.error('API error ' + req.url, err);
		res.status(500).send({success: false, error: 'API error: ' + err.message});
	});
};

// Public methods

// Events
//
//__EVENT__ `onBind`

//
Multisignatures.prototype.onBind = function (scope) {
	modules = scope;

	__private.assetTypes[transactionTypes.MULTI].bind({
		modules: modules, library: library
	});
};



//
//__EVENT__ `onAttachPublicApi`

//
Multisignatures.prototype.onAttachPublicApi = function () {
 	__private.attachApi();
};

shared.getAccounts = function (req, cb) {
	library.schema.validate(req.body, schema.getAccounts, function (err) {
		if (err) {
			return setImmediate(cb, err[0].message);
		}

		library.db.one(sql.getAccounts, { publicKey: req.body.publicKey }).then(function (row) {
			var addresses = Array.isArray(row.accountId) ? row.accountId : [];

			modules.accounts.getAccounts({
				address: { $in: addresses },
				sort: 'balance'
			}, ['address', 'balance', 'multisignatures', 'multilifetime', 'multimin'], function (err, rows) {
				if (err) {
					return setImmediate(cb, err);
				}

				async.eachSeries(rows, function (account, cb) {
					var addresses = [];
					for (var i = 0; i < account.multisignatures.length; i++) {
						addresses.push(modules.accounts.generateAddressByPublicKey(account.multisignatures[i]));
					}

					modules.accounts.getAccounts({
						address: { $in: addresses }
					}, ['address', 'publicKey', 'balance'], function (err, multisigaccounts) {
						if (err) {
							return setImmediate(cb, err);
						}

						account.multisigaccounts = multisigaccounts;
						return setImmediate(cb);
					});
				}, function (err) {
					if (err) {
						return setImmediate(cb, err);
					}

					return setImmediate(cb, null, {accounts: rows});
				});
			});
		}).catch(function (err) {
			library.logger.error("stack", err.stack);
			return setImmediate(cb, 'Multisignature#getAccounts error');
		});
	});
};

// Shared
shared.pending = function (req, cb) {
	var scope = { pending: [] };

	async.series({
		validateSchema: function (seriesCb) {
			library.schema.validate(req.body, schema.pending, function (err) {
				if (err) {
					return setImmediate(seriesCb, err[0].message);
				} else {
					return setImmediate(seriesCb);
				}
			});
		},
		getTransactionList: function (seriesCb) {
			scope.transactions = modules.transactionPool.getMultisignatureTransactionList(false, false);
			scope.transactions = scope.transactions.filter(function (transaction) {
				return transaction.senderPublicKey === req.body.publicKey;
			});

			return setImmediate(seriesCb);
		},
		buildTransactions: function (seriesCb) {
			async.eachSeries(scope.transactions, function (transaction, eachSeriesCb) {
				var signed = false;

				if (transaction.signatures && transaction.signatures.length > 0) {
					var verify = false;

					for (var i in transaction.signatures) {
						var signature = transaction.signatures[i];

						try {
							verify = library.logic.transaction.verifySignature(transaction, req.body.publicKey, transaction.signatures[i]);
						} catch (e) {
							library.logger.error("stack", e.stack);
							verify = false;
						}

						if (verify) {
							break;
						}
					}

					if (verify) {
						signed = true;
					}
				}

				if (!signed && transaction.senderPublicKey === req.body.publicKey) {
					signed = true;
				}

				modules.accounts.getAccount({
					publicKey: transaction.senderPublicKey
				}, function (err, sender) {
					if (err) {
						return setImmediate(cb, err);
					}

					if (!sender) {
						return setImmediate(cb, 'Sender not found');
					}

					var min = sender.u_multimin || sender.multimin;
					var lifetime = sender.u_multilifetime || sender.multilifetime;
					var signatures = sender.u_multisignatures || [];

					scope.pending.push({
						max: signatures.length,
						min: min,
						lifetime: lifetime,
						signed: signed,
						transaction: transaction
					});

					return setImmediate(eachSeriesCb);
				});
			}, function (err) {
				return setImmediate(seriesCb, err);
			});
		}
	}, function (err) {
		return setImmediate(cb, err, {transactions: scope.pending});
	});
};

shared.sign = function (req, cb) {
	var scope = {};

	function checkGroupPermisions (cb) {
		var permissionDenied = (
			scope.transaction.asset.multisignature.keysgroup.indexOf('+' + scope.keypair.publicKey.toString('hex')) === -1
		);

		if (permissionDenied) {
			return setImmediate(cb, 'Permission to sign transaction denied');
		}

		var alreadySigned = (
			Array.isArray(scope.transaction.signatures) &&
			scope.transaction.signatures.indexOf(scope.signature.toString('hex')) !== -1
		);

		if (alreadySigned) {
			return setImmediate(cb, 'Transaction already signed');
		}

		return setImmediate(cb);
	}

	function checkTransactionPermissions (cb) {
		var permissionDenied = true;

		if (!scope.transaction.requesterPublicKey) {
			permissionDenied = (
				(scope.sender.multisignatures.indexOf(scope.keypair.publicKey.toString('hex')) === -1)
			);
		} else {
			permissionDenied = (
				(scope.sender.publicKey !== scope.keypair.publicKey.toString('hex') || (scope.transaction.senderPublicKey !== scope.keypair.publicKey.toString('hex')))
			);
		}

		if (permissionDenied)  {
			return setImmediate(cb, 'Permission to sign transaction denied');
		}

		var alreadySigned = (scope.transaction.signatures && scope.transaction.signatures.indexOf(scope.signature) !== -1);

		if (alreadySigned) {
			return setImmediate(cb, 'Transaction already signed');
		}

		return setImmediate(cb);
	}

	library.balancesSequence.add(function (cb) {
		async.series({
			validateSchema: function (seriesCb) {
				library.schema.validate(req.body, schema.sign, function (err) {
					if (err) {
						return setImmediate(seriesCb, err[0].message);
					} else {
						return setImmediate(seriesCb);
					}
				});
			},
			signTransaction: function (seriesCb) {
				scope.transaction = modules.transactionPool.getMultisignatureTransaction(req.body.transactionId);

				if (!scope.transaction) {
					return setImmediate(seriesCb, 'Transaction not found');
				}

				scope.keypair = library.ed.makeKeypair(req.body.secret);

				if (req.body.publicKey) {
					if (scope.keypair.publicKey.toString('hex') !== req.body.publicKey) {
						return setImmediate(seriesCb, 'Invalid passphrase');
					}
				}

				scope.signature = library.logic.transaction.multisign(scope.keypair, scope.transaction);
				return setImmediate(seriesCb);
			},
			getAccount: function (seriesCb) {
				modules.accounts.getAccount({
					address: scope.transaction.senderId
				}, function (err, sender) {
					if (err) {
						return setImmediate(seriesCb, err);
					} else if (!sender) {
						return setImmediate(seriesCb, 'Sender not found');
					} else {
						scope.sender = sender;
						return setImmediate(seriesCb);
					}
				});
			},
			checkPermissions: function (seriesCb) {
				if (scope.transaction.type === transactionTypes.MULTI) {
					return checkGroupPermisions(seriesCb);
				} else {
					return checkTransactionPermissions(seriesCb);
				}
			}
		}, function (err) {
			if (err) {
				return setImmediate(cb, err);
			}

			var transaction = modules.transactionPool.getMultisignatureTransaction(req.body.transactionId);

			if (!transaction) {
				return setImmediate(cb, 'Transaction not found');
			}

			transaction.signatures = transaction.signatures || [];
			transaction.signatures.push(scope.signature);
			transaction.ready = Multisignature.prototype.ready(transaction, scope.sender);

			library.bus.message('signature', {transaction: transaction.id, signature: scope.signature}, true);
			library.network.io.sockets.emit('multisignatures/signature/change', transaction);

			return setImmediate(cb, null, {transactionId: transaction.id});
		});
	}, cb);
};

//
//__API__ `processSignature`

//
Multisignatures.prototype.processSignature = function (tx, cb) {
	var transaction = modules.transactionPool.getUnconfirmedTransaction(tx.transaction);

	function done (transaction, cb) {
		library.balancesSequence.add(function (cb) {

			modules.accounts.getAccount({
				address: transaction.senderId
			}, function (err, sender) {
				if (err) {
					return setImmediate(cb, err);
				} else if (!sender) {
					return setImmediate(cb, 'Sender not found');
				} else {
					transaction.signatures = transaction.signatures || [];
					transaction.signatures.push(tx.signature);
					transaction.ready = Multisignature.prototype.ready(transaction, sender);
					library.bus.message('signature', {transaction: tx.transaction, signature: tx.signature}, true);
					return setImmediate(cb);
				}
			});
		}, cb);
	}

	if (!transaction) {
		return setImmediate(cb, 'Missing transaction');
	}

	if (transaction.type === transactionTypes.MULTI) {
		transaction.signatures = transaction.signatures || [];

		if (transaction.asset.multisignature.signatures || transaction.signatures.indexOf(tx.signature) !== -1) {
			return setImmediate(cb, 'Permission to sign transaction denied');
		}

		// Find public key
		var verify = false;

		try {
			for (var i = 0; i < transaction.asset.multisignature.keysgroup.length && !verify; i++) {
				var key = transaction.asset.multisignature.keysgroup[i].substring(1);
				verify = library.logic.transaction.verifySignature(transaction, key, tx.signature);
			}
		} catch (e) {
			library.logger.error("stack", e.stack);
			return setImmediate(cb, 'Failed to verify signature');
		}

		if (!verify) {
			return setImmediate(cb, 'Failed to verify signature');
		}

		return done(transaction, cb);
	} else {
		modules.accounts.getAccount({
			address: transaction.senderId
		}, function (err, account) {
			if (err) {
				return setImmediate(cb, 'Multisignature account not found');
			}

			var verify = false;
			var multisignatures = account.multisignatures;

			if (transaction.requesterPublicKey) {
				multisignatures.push(transaction.senderPublicKey);
			}

			if (!account) {
				return setImmediate(cb, 'Account not found');
			}

			transaction.signatures = transaction.signatures || [];

			if (transaction.signatures.indexOf(tx.signature) >= 0) {
				return setImmediate(cb, 'Signature already exists');
			}

			try {
				for (var i = 0; i < multisignatures.length && !verify; i++) {
					verify = library.logic.transaction.verifySignature(transaction, multisignatures[i], tx.signature);
				}
			} catch (e) {
				library.logger.error("stack", e.stack);
				return setImmediate(cb, 'Failed to verify signature');
			}

			if (!verify) {
				return setImmediate(cb, 'Failed to verify signature');
			}

			library.network.io.sockets.emit('multisignatures/signature/change', {});
			return done(cb);
		});
	}
};

shared.addMultisignature = function (req, cb) {
	library.schema.validate(req.body, schema.addMultisignature, function (err) {
		if (err) {
			return setImmediate(cb, err[0].message);
		}

		var keypair = library.ed.makeKeypair(req.body.secret);

		if (req.body.publicKey) {
			if (keypair.publicKey.toString('hex') !== req.body.publicKey) {
				return setImmediate(cb, 'Invalid passphrase');
			}
		}

		library.balancesSequence.add(function (cb) {
			modules.accounts.setAccountAndGet({publicKey: keypair.publicKey.toString('hex')}, function (err, account) {
				if (err) {
					return setImmediate(cb, err);
				}

				if (!account || !account.publicKey) {
					return setImmediate(cb, 'Account not found');
				}

				if (account.secondSignature && !req.body.secondSecret) {
					return setImmediate(cb, 'Invalid second passphrase');
				}

				var secondKeypair = null;

				if (account.secondSignature) {
					secondKeypair = library.ed.makeKeypair(req.body.secondSecret);
				}

				var transaction;

				try {
					transaction = library.logic.transaction.create({
						type: transactionTypes.MULTI,
						sender: account,
						keypair: keypair,
						secondKeypair: secondKeypair,
						min: req.body.min,
						keysgroup: req.body.keysgroup,
						lifetime: req.body.lifetime
					});
				} catch (e) {
					return setImmediate(cb, e.toString());
				}

				library.bus.message("transactionsReceived", [transaction], "api", cb);
			});
		}, function (err, transaction) {
			if (err) {
				return setImmediate(cb, err);
			}

			library.network.io.sockets.emit('multisignatures/change', {});
			return setImmediate(cb, null, {transactionId: transaction[0].id});
		});
	});
};

// Export
module.exports = Multisignatures;
