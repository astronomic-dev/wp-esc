<?php
/**
 * Plugin Name: wp-esc test: business types
 * Description: The `business` test site's custom types. `service` is in REST;
 * `team` is public (sitemap, WXR) but has show_in_rest off, so a public read
 * sees it only through the sitemap. `service_area` is a custom taxonomy.
 */

add_action('init', function () {
	register_post_type('service', [
		'label' => 'Services',
		'labels' => ['singular_name' => 'Service'],
		'public' => true,
		'has_archive' => true,
		'show_in_rest' => true,
		'rest_base' => 'services',
		'rewrite' => ['slug' => 'services'],
		'supports' => ['title', 'editor', 'excerpt', 'thumbnail', 'custom-fields'],
	]);
	register_post_type('team', [
		'label' => 'Team',
		'labels' => ['singular_name' => 'Team member'],
		'public' => true,
		'has_archive' => true,
		'show_in_rest' => false,
		'rewrite' => ['slug' => 'team'],
		'supports' => ['title', 'editor', 'thumbnail', 'custom-fields'],
	]);
	register_taxonomy('service_area', ['service'], [
		'label' => 'Service areas',
		'hierarchical' => true,
		'public' => true,
		'show_in_rest' => true,
		'rest_base' => 'service-areas',
		'rewrite' => ['slug' => 'service-area'],
	]);
});
