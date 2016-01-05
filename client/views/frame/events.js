Router.map(function () {
	this.route('frameEvents', {
		path: '/frame/events',
		template: 'frameEvents',
		layoutTemplate: 'frameLayout',
		waitOn: function () {
			this.filter = Filtering(EventPredicates).read(this.params.query).done();

			var filterParams = this.filter.toParams();
			filterParams.after = minuteTime.get();

			var limit = parseInt(this.params.query.count, 10) || 6;

			return Meteor.subscribe('eventsFind', filterParams, limit*2);
		},

		data: function() {
			var filterParams = this.filter.toParams();
			filterParams.after = minuteTime.get();

			var limit = parseInt(this.params.query.count, 10) || 6;

			return eventsFind(filterParams, limit);
		},

		onAfterAction: function() {
			document.title = webpagename + ' Events';
		}
	});
});

Template.frameEvent.onRendered(function() {
	this.$('.-eventLocationTime').dotdotdot({
		height: 50,
		watch : "window",
	});
	this.$('.-eventTitle').dotdotdot({
		watch: "window",
	});
	this.$('.-eventDescription').dotdotdot({
		watch: "window",
	});
});

Template.frameEvent.helpers({
	timely: function() {
		return moment().add(1, 'day').isAfter(this) && moment().subtract(1, 'day').isBefore(this);
	},
});
