<?php
/**
 * Plugin Name: wp-esc test: REST off for visitors
 * Description: Used only for the `blog-rest-off` recording. Anonymous REST
 * requests get 401, as with the many "disable REST API" plugins. Requests
 * signed with an application password still work.
 */

add_filter('rest_authentication_errors', function ($result) {
	if (!empty($result)) return $result;
	if (!is_user_logged_in()) {
		return new WP_Error('rest_not_logged_in', 'You are not currently logged in.', ['status' => 401]);
	}
	return $result;
});
