import { Meteor } from 'meteor/meteor';
import { _ } from 'meteor/underscore';

import Courses from './courses.js';
import Events from '/imports/api/events/events.js';
import Groups from '/imports/api/groups/groups.js';
import Regions from '/imports/api/regions/regions.js';
import Roles from '/imports/api/roles/roles.js';
import UpdateMethods from '/imports/utils/update-methods.js';
import {
	HasRoleUser,
	MaySubscribe,
	MayUnsubscribe
} from '/imports/utils/course-role-utils.js';

import '/imports/AsyncTools.js';
import '/imports/StringTools.js';
import '/imports/HtmlTools.js';

import { PleaseLogin, IsEmail } from '/imports/ui/lib/please-login.js';

function addRole(course, role, user) {
	// Add the user as member if she's not listed yet
	Courses.update(
		{ _id: course._id, 'members.user': { $ne: user } },
		{ $addToSet: { 'members': { user: user, roles: [ role ]} }}
	);

	Courses.update(
		{ _id: course._id, 'members.user': user },
		{ '$addToSet': { 'members.$.roles': role }}
	);

	Courses.updateGroups(course._id);
}


function removeRole(course, role, user) {
	Courses.update(
		{ _id: course._id, 'members.user': user },
		{ '$pull': { 'members.$.roles': role }}
	);

	// Housekeeping: Remove members that have no role left
	Courses.update(
		{ _id: course._id },
		{ $pull: { members: { roles: { $size: 0 } }}}
	);

	Courses.updateGroups(course._id);
}

Meteor.methods({
	'course.addRole': function(courseId, userId, role) {
		check(courseId, String);
		check(userId, String);
		check(role, String);

		var user = Meteor.users.findOne(userId);
		if (!user) throw new Meteor.Error(404, "User not found");

		var operator = Meteor.user();
		if (!operator) throw new Meteor.Error(401, "please log in");

		var course = Courses.findOne({_id: courseId});
		if (!course) throw new Meteor.Error(404, "Course not found");

		if (course.roles.indexOf(role) == -1) throw new Meteor.Error(404, "No role "+role);

		// do nothing if user is already subscribed with this role
		if (HasRoleUser(course.members, role, userId)) return true;

		// Check permissions
		if (!MaySubscribe(operator._id, course, user._id, role)) {
			throw new Meteor.Error(401, "not permitted");
		}

		addRole(course, role, user._id);

		// Update the modification date
		Courses.update(courseId, { $set: {time_lastedit: new Date()} });

		// Send notifications
		Notification.Join.record(course._id, user._id, role);
	},

	'course.removeRole': function(courseId, userId, role) {
		check(role, String);
		check(userId, String);
		check(courseId, String);

		var user = Meteor.users.findOne(userId);
		if (!user) throw new Meteor.Error(404, "User not found");

		var operator = Meteor.user();
		if (!operator) throw new Meteor.Error(401, "please log in");

		var course = Courses.findOne({_id: courseId});
		if (!course) throw new Meteor.Error(404, "Course not found");

		// do nothing if user is not subscribed with this role
		if (!HasRoleUser(course.members, role, userId)) return true;

		// Check permissions
		 if (!MayUnsubscribe(operator._id, course, user._id, role)) {
			throw new Meteor.Error(401, "not permitted");
		}

		removeRole(course, role, user._id);
	},

	'course.changeComment': function(courseId, comment) {
		check(courseId, String);
		check(comment, String);
		var course = Courses.findOne({_id: courseId});
		if (!course) throw new Meteor.Error(404, "Course not found");

		Courses.update(
			{ _id: course._id, 'members.user': Meteor.userId() },
			{ $set: { 'members.$.comment': comment } }
		);
	},

	'course.save': function(courseId, changes) {
		check(courseId, String);
		check(changes, {
			description: Match.Optional(String),
			categories:  Match.Optional([String]),
			name:        Match.Optional(String),
			region:      Match.Optional(String),
			roles:       Match.Optional(Object),
			groups:      Match.Optional([String]),
			internal:    Match.Optional(Boolean),
			emailSignup: Match.Optional(String),
		});

		const isNew = courseId.length === 0;
		let createVisitor = false;

		 if (!user) {
			if (isNew && changes.emailSignup) {
				if (!IsEmail(changes.emailSignup)) {
					throw new Meteor.Error(400, "email address not accepted");
				}
				user = {};
				createVisitor = true;
			} else {
				if (Meteor.isClient) {
					PleaseLogin();
					return;
				} else {
					throw new Meteor.Error(401, "please log in");
				}
			}
		}

		var course;
		if (isNew) {
			course = new Course();
		} else {
			course = Courses.findOne({_id: courseId});
			if (!course) throw new Meteor.Error(404, "Course not found");
		}

		if (!course.editableBy(user)) throw new Meteor.Error(401, "edit not permitted");

		/* Changes we want to perform */
		var set = {};

		if (changes.roles) {
			_.each(Roles, function(roletype) {
				var type = roletype.type;
				var should_have = roletype.preset || changes.roles && changes.roles[type];
				var have = course.roles.indexOf(type) !== -1;

				if (have && !should_have) {
					Courses.update(
						{ _id: courseId },
						{ $pull: { roles: type }},
						AsyncTools.checkUpdateOne
					);

					// HACK
					// due to a mongo limitation we can't { $pull { 'members.roles': type } }
					// so we keep removing one by one until there are none left
					while(Courses.update(
						{ _id: courseId, "members.roles": type },
						{ $pull: { 'members.$.roles': type }}
					));
				}
				if (!have && should_have) {
					if (isNew) {
						set.roles = set.roles || [];
						set.roles.push(type);
					} else {
						Courses.update(
							{ _id: courseId },
							{ $addToSet: { roles: type }},
							AsyncTools.checkUpdateOne
						);
					}
				}
			});
		}

		if (changes.description) {
			set.description = changes.description.substring(0, 640*1024); /* 640 k ought to be enough for everybody  -- Mao */
			if (Meteor.isServer) {
				set.description = HtmlTools.saneHtml(set.description);
			}
		}

		if (changes.categories) set.categories = changes.categories.slice(0, 20);
		if (changes.name) {
			set.name = StringTools.saneTitle(changes.name).substring(0, 1000);
			set.slug = StringTools.slug(set.name);
		}
		if (changes.internal !== undefined) {
			set.internal = changes.internal;
		}

		set.time_lastedit = new Date();
		if (isNew) {
			// You can add newly created courses to any group
			var tested_groups = [];
			if (changes.groups) {
				tested_groups = _.map(changes.groups, function(groupId) {
					var group = Groups.findOne(groupId);
					if (!group) throw new Meteor.Error(404, "no group with id "+groupId);
					return group._id;
				});
			}
			set.groups = tested_groups;
			set.groupOrganizers = tested_groups;

			/* region cannot be changed */
			var region = Regions.findOne({_id: changes.region});
			if (!region) throw new Meteor.Error(404, 'region missing');
			set.region = region._id;

			let userId;
			if (createVisitor) {
				if (Meteor.isClient) return; // Don't attempt simulating creating a visitor user
				userId = Accounts.createUser({ email: changes.emailSignup });
				Accounts.sendEnrollmentEmail(userId);
			} else {
				userId = user._id;
			}

			/* When a course is created, the creator is automatically added as sole member of the team */
			set.members = [{
				user: userId,
				roles: ['participant', 'team'],
				comment: mf('courses.creator.defaultMessage', '(has proposed this course)')}
			];
			set.editors = [userId];
			set.createdby = userId;
			set.time_created = new Date();
			courseId = Courses.insert(set);

			Meteor.call('course.updateNextEvent', courseId);
		} else {
			Courses.update({ _id: courseId }, { $set: set }, AsyncTools.checkUpdateOne);
		}

		return courseId;
	},

	'course.remove': function(courseId) {
		var course = Courses.findOne({_id: courseId});
		if (!course) throw new Meteor.Error(404, "no such course");
		if (!course.editableBy(Meteor.user())) throw new Meteor.Error(401, "edit not permitted");
		Events.remove({ courseId: courseId });
		Courses.remove(courseId);
	},

	// Update the nextEvent field for the courses matching the selector
	'course.updateNextEvent': function(selector) {
		Courses.find(selector).forEach(function(course) {
			var futureEvents = Events.find(
				{courseId: course._id, start: {$gt: new Date()}}
			).count();

			var nextEvent = Events.findOne(
				{ courseId: course._id, start: {$gt: new Date()} },
				{ sort: {start: 1}, fields: {startLocal: 1, start: 1, _id: 1, venue: 1} }
			);

			var lastEvent = Events.findOne(
				{ courseId: course._id, start: {$lt: new Date()} },
				{ sort: {start: -1}, fields: {startLocal: 1, start: 1, _id: 1, venue: 1} }
			);

			Courses.update(course._id, { $set: {
				futureEvents: futureEvents,
				nextEvent: nextEvent,
				lastEvent: lastEvent,
			} });
		});
	},

	/** Add or remove a group from the groups list
	  *
	  * @param {String} courseId - The course to update
	  * @param {String} groupId - The group to add or remove
	  * @param {Boolean} add - Whether to add or remove the group
	  *
	  */
	'course.promote': UpdateMethods.Promote(Courses),


	/** Add or remove a group from the groupOrganizers list
	  *
	  * @param {String} courseId - The course to update
	  * @param {String} groupId - The group to add or remove
	  * @param {Boolean} add - Whether to add or remove the group
	  *
	  */
	'course.editing': UpdateMethods.Editing(Courses),


	// Recalculate the editors field
	'course.updateGroups': function(selector) {
		Courses.find(selector).forEach(function(course) {
			Courses.updateGroups(course._id);
		});
	},
});
