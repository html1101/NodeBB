'use strict';

var async = require('async');
var _ = require('underscore');

var db = require('../database');
var categories = require('../categories');
var plugins = require('../plugins');
var privileges = require('../privileges');


module.exports = function (Topics) {

	var topicTools = {};
	Topics.tools = topicTools;


	topicTools.delete = function (tid, uid, callback) {
		toggleDelete(tid, uid, true, callback);
	};

	topicTools.restore = function (tid, uid, callback) {
		toggleDelete(tid, uid, false, callback);
	};

	function toggleDelete(tid, uid, isDelete, callback) {
		var topicData;
		async.waterfall([
			function (next) {
				Topics.exists(tid, next);
			},
			function (exists, next) {
				if (!exists) {
					return next(new Error('[[error:no-topic]]'));
				}
				privileges.topics.canDelete(tid, uid, next);
			},
			function (canDelete, next) {
				if (!canDelete) {
					return next(new Error('[[error:no-privileges]]'));
				}
				Topics.getTopicFields(tid, ['tid', 'cid', 'uid', 'deleted', 'title', 'mainPid'], next);
			},
			function (_topicData, next) {
				topicData = _topicData;

				if (parseInt(topicData.deleted, 10) === 1 && isDelete) {
					return callback(new Error('[[error:topic-already-deleted]]'));
				} else if (parseInt(topicData.deleted, 10) !== 1 && !isDelete) {
					return callback(new Error('[[error:topic-already-restored]]'));
				}

				Topics[isDelete ? 'delete' : 'restore'](tid, uid, next);
			},
			function (next) {
				topicData.deleted = isDelete ? 1 : 0;

				if (isDelete) {
					plugins.fireHook('action:topic.delete', topicData);
				} else {
					plugins.fireHook('action:topic.restore', topicData);
				}

				var data = {
					tid: tid,
					cid: topicData.cid,
					isDelete: isDelete,
					uid: uid,
				};

				next(null, data);
			},
		], callback);
	}

	topicTools.purge = function (tid, uid, callback) {
		var cid;
		async.waterfall([
			function (next) {
				Topics.exists(tid, next);
			},
			function (exists, next) {
				if (!exists) {
					return callback();
				}
				privileges.topics.canPurge(tid, uid, next);
			},
			function (canPurge, next) {
				if (!canPurge) {
					return next(new Error('[[error:no-privileges]]'));
				}

				Topics.getTopicField(tid, 'cid', next);
			},
			function (_cid, next) {
				cid = _cid;

				Topics.purgePostsAndTopic(tid, uid, next);
			},
			function (next) {
				next(null, {tid: tid, cid: cid, uid: uid});
			},
		], callback);
	};

	topicTools.lock = function (tid, uid, callback) {
		toggleLock(tid, uid, true, callback);
	};

	topicTools.unlock = function (tid, uid, callback) {
		toggleLock(tid, uid, false, callback);
	};

	function toggleLock(tid, uid, lock, callback) {
		callback = callback || function () {};

		var cid;

		async.waterfall([
			function (next) {
				Topics.getTopicField(tid, 'cid', next);
			},
			function (_cid, next) {
				cid = _cid;
				if (!cid) {
					return next(new Error('[[error:no-topic]]'));
				}
				privileges.categories.isAdminOrMod(cid, uid, next);
			},
			function (isAdminOrMod, next) {
				if (!isAdminOrMod) {
					return next(new Error('[[error:no-privileges]]'));
				}

				Topics.setTopicField(tid, 'locked', lock ? 1 : 0, next);
			},
			function (next) {
				var data = {
					tid: tid,
					isLocked: lock,
					uid: uid,
					cid: cid,
				};

				plugins.fireHook('action:topic.lock', data);

				next(null, data);
			},
		], callback);
	}

	topicTools.pin = function (tid, uid, callback) {
		togglePin(tid, uid, true, callback);
	};

	topicTools.unpin = function (tid, uid, callback) {
		togglePin(tid, uid, false, callback);
	};

	function togglePin(tid, uid, pin, callback) {
		var topicData;
		async.waterfall([
			function (next) {
				Topics.exists(tid, next);
			},
			function (exists, next) {
				if (!exists) {
					return callback(new Error('[[error:no-topic]]'));
				}
				Topics.getTopicFields(tid, ['cid', 'lastposttime', 'postcount'], next);
			},
			function (_topicData, next) {
				topicData = _topicData;
				privileges.categories.isAdminOrMod(_topicData.cid, uid, next);
			},
			function (isAdminOrMod, next) {
				if (!isAdminOrMod) {
					return next(new Error('[[error:no-privileges]]'));
				}

				async.parallel([
					async.apply(Topics.setTopicField, tid, 'pinned', pin ? 1 : 0),
					function (next) {
						if (pin) {
							async.parallel([
								async.apply(db.sortedSetAdd, 'cid:' + topicData.cid + ':tids:pinned', Date.now(), tid),
								async.apply(db.sortedSetRemove, 'cid:' + topicData.cid + ':tids', tid),
								async.apply(db.sortedSetRemove, 'cid:' + topicData.cid + ':tids:posts', tid),
							], next);
						} else {
							async.parallel([
								async.apply(db.sortedSetRemove, 'cid:' + topicData.cid + ':tids:pinned', tid),
								async.apply(db.sortedSetAdd, 'cid:' + topicData.cid + ':tids', topicData.lastposttime, tid),
								async.apply(db.sortedSetAdd, 'cid:' + topicData.cid + ':tids:posts', topicData.postcount, tid),
							], next);
						}
					},
				], next);
			},
			function (results, next) {
				var data = {
					tid: tid,
					isPinned: pin,
					uid: uid,
					cid: topicData.cid,
				};

				plugins.fireHook('action:topic.pin', data);

				next(null, data);
			},
		], callback);
	}

	topicTools.orderPinnedTopics = function (uid, data, callback) {
		var cid;
		async.waterfall([
			function (next) {
				var tids = data.map(function (topic) {
					return topic && topic.tid;
				});
				Topics.getTopicsFields(tids, ['cid'], next);
			},
			function (topicData, next) {
				var uniqueCids = _.unique(topicData.map(function (topicData) {
					return topicData && parseInt(topicData.cid, 10);
				}));

				if (uniqueCids.length > 1 || !uniqueCids.length || !uniqueCids[0]) {
					return next(new Error('[[error:invalid-data]]'));
				}
				cid = uniqueCids[0];

				privileges.categories.isAdminOrMod(cid, uid, next);
			},
			function (isAdminOrMod, next) {
				if (!isAdminOrMod) {
					return next(new Error('[[error:no-privileges]]'));
				}
				async.eachSeries(data, function (topicData, next) {
					async.waterfall([
						function (next) {
							db.isSortedSetMember('cid:' + cid + ':tids:pinned', topicData.tid, next);
						},
						function (isPinned, next) {
							if (isPinned) {
								db.sortedSetAdd('cid:' + cid + ':tids:pinned', topicData.order, topicData.tid, next);
							} else {
								setImmediate(next);
							}
						},
					], next);
				}, next);
			},
		], callback);
	};

	topicTools.move = function (tid, cid, uid, callback) {
		var topic;
		async.waterfall([
			function (next) {
				Topics.exists(tid, next);
			},
			function (exists, next) {
				if (!exists) {
					return next(new Error('[[error:no-topic]]'));
				}
				Topics.getTopicFields(tid, ['cid', 'lastposttime', 'pinned', 'deleted', 'postcount'], next);
			},
			function (topicData, next) {
				topic = topicData;
				db.sortedSetsRemove([
					'cid:' + topicData.cid + ':tids',
					'cid:' + topicData.cid + ':tids:pinned',
					'cid:' + topicData.cid + ':tids:posts',	// post count
				], tid, next);
			},
			function (next) {
				if (parseInt(topic.pinned, 10)) {
					db.sortedSetAdd('cid:' + cid + ':tids:pinned', Date.now(), tid, next);
				} else {
					async.parallel([
						function (next) {
							db.sortedSetAdd('cid:' + cid + ':tids', topic.lastposttime, tid, next);
						},
						function (next) {
							topic.postcount = topic.postcount || 0;
							db.sortedSetAdd('cid:' + cid + ':tids:posts', topic.postcount, tid, next);
						},
					], next);
				}
			},
		], function (err) {
			if (err) {
				return callback(err);
			}
			var oldCid = topic.cid;
			categories.moveRecentReplies(tid, oldCid, cid);

			async.parallel([
				function (next) {
					categories.incrementCategoryFieldBy(oldCid, 'topic_count', -1, next);
				},
				function (next) {
					categories.incrementCategoryFieldBy(cid, 'topic_count', 1, next);
				},
				function (next) {
					Topics.setTopicFields(tid, {
						cid: cid,
						oldCid: oldCid,
					}, next);
				},
			], function (err) {
				if (err) {
					return callback(err);
				}
				plugins.fireHook('action:topic.move', {
					tid: tid,
					fromCid: oldCid,
					toCid: cid,
					uid: uid,
				});
				callback();
			});
		});
	};


};
