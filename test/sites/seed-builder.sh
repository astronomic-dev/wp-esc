#!/bin/sh
# Seed the `builder` site (port 4603). Run by record.mjs inside cli-builder:
#   docker compose ... run --rm -T -e WPM_URL=http://localhost:4603 cli-builder sh /seed/seed-builder.sh
#
# Plain permalinks (the API is at ?rest_route=/), Elementor pages with
# `_elementor_data`, Classic pages with [gallery], [contact-form-7 ...] and an
# unregistered [pricing_table], and Gutenberg block pages. Contact Form 7 runs
# without Flamingo, so no form messages are stored.

. /seed/seed-common.sh

install_core "$WPM_URL" "Northwind Studio" "Websites and brand work for local shops"
add_author theo-marsh editor "Theo Marsh"
plugin elementor "$WPM_ELEMENTOR_VERSION"
plugin contact-form-7 "$WPM_CF7_VERSION"
wp rewrite structure '' --quiet
make_images

wp eval-file - --user=theo-marsh <<'PHP'
<?php
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

function wpm_fail($e) { fwrite(STDERR, (is_wp_error($e) ? $e->get_error_message() : $e) . "\n"); exit(1); }
function wpm_image($n, $title) {
	$tmp = "/tmp/wpm-copy-" . sanitize_title($title) . ".png";
	copy("/tmp/wpm-img-$n.png", $tmp);
	$id = media_handle_sideload(['name' => sanitize_title($title) . '.png', 'tmp_name' => $tmp], 0, $title);
	if (is_wp_error($id)) wpm_fail($id);
	return $id;
}
function wpm_post($args) {
	$id = wp_insert_post($args + ['post_status' => 'publish', 'post_type' => 'page', 'post_date' => '2024-05-01 09:00:00'], true);
	if (is_wp_error($id)) wpm_fail($id);
	return $id;
}

$images = [];
for ($i = 1; $i <= 6; $i++) $images[] = wpm_image($i, "Studio work $i");

$forms = get_posts(['post_type' => 'wpcf7_contact_form', 'numberposts' => 1]);
if ($forms) { $form = wpcf7_contact_form($forms[0]->ID); }
else { $form = WPCF7_ContactForm::get_template(['title' => 'Contact form 1']); $form->save(); }

// Elementor pages: layout JSON in _elementor_data, plain fallback in post_content.
$n = 0;
$eid = function () use (&$n) { $n++; return substr(md5("wpm-el-$n"), 0, 7); };
$widget = function ($type, $settings) use ($eid) {
	return ['id' => $eid(), 'elType' => 'widget', 'widgetType' => $type, 'settings' => $settings, 'elements' => []];
};
$section = function ($widgets) use ($eid) {
	return ['id' => $eid(), 'elType' => 'section', 'settings' => [], 'elements' => [
		['id' => $eid(), 'elType' => 'column', 'settings' => ['_column_size' => 100], 'elements' => $widgets],
	]];
};
$elementorPages = [
	['Home', 'elementor_header_footer'],
	['Services', ''],
	['Our process', 'elementor_canvas'],
];
$ids = [];
foreach ($elementorPages as $k => [$title, $template]) {
	$data = [
		$section([
			$widget('heading', ['title' => "$title at Northwind", 'header_size' => 'h1']),
			$widget('text-editor', ['editor' => "<p>We build $title pages that load fast.</p>"]),
			$widget('image', ['image' => ['id' => $images[$k], 'url' => wp_get_attachment_url($images[$k])]]),
			$widget('button', ['text' => 'Book a call', 'link' => ['url' => home_url('/?page_id=0'), 'is_external' => '', 'nofollow' => '']]),
		]),
		$section([
			$widget('icon-list', ['icon_list' => [['_id' => $eid(), 'text' => 'Strategy'], ['_id' => $eid(), 'text' => 'Design'], ['_id' => $eid(), 'text' => 'Build']]]),
			$widget('shortcode', ['shortcode' => '[pricing_table plan="starter"]']),
		]),
	];
	$id = wpm_post(['post_title' => $title, 'post_content' => "<h1>$title at Northwind</h1><p>We build $title pages that load fast.</p>"]);
	update_post_meta($id, '_elementor_edit_mode', 'builder');
	update_post_meta($id, '_elementor_template_type', 'wp-page');
	update_post_meta($id, '_elementor_version', ELEMENTOR_VERSION);
	update_post_meta($id, '_elementor_data', wp_slash(wp_json_encode($data)));
	if ($template) update_post_meta($id, '_wp_page_template', $template);
	$ids[$title] = $id;
}
update_option('show_on_front', 'page');
update_option('page_on_front', $ids['Home']);

// Classic pages (no block comments).
$gallery = implode(',', array_slice($images, 0, 4));
wpm_post(['post_title' => 'Portfolio', 'post_content' => "<p>Recent work for shops in town.</p>\n\n[gallery ids=\"$gallery\" columns=\"2\"]\n\n<p>Ask about a package.</p>"]);
wpm_post(['post_title' => 'Pricing', 'post_content' => "<p>Three plans, no surprises.</p>\n\n[pricing_table plan=\"pro\" columns=\"3\"]\n\n<p>All plans include hosting setup.</p>"]);
wpm_post(['post_title' => 'Contact', 'post_content' => "<p>Tell us about your shop.</p>\n\n" . $form->shortcode() . "\n\n<p>We reply within two days.</p>"]);

// Gutenberg block pages.
$img = $images[4];
$url = wp_get_attachment_url($img);
wpm_post(['post_title' => 'About', 'post_content' =>
	"<!-- wp:heading {\"level\":1} -->\n<h1 class=\"wp-block-heading\">About Northwind</h1>\n<!-- /wp:heading -->\n\n"
	. "<!-- wp:paragraph -->\n<p>A two-person studio.</p>\n<!-- /wp:paragraph -->\n\n"
	. "<!-- wp:image {\"id\":$img,\"sizeSlug\":\"large\"} -->\n<figure class=\"wp-block-image size-large\"><img src=\"$url\" alt=\"\" class=\"wp-image-$img\"/></figure>\n<!-- /wp:image -->\n\n"
	. "<!-- wp:quote -->\n<blockquote class=\"wp-block-quote\"><!-- wp:paragraph -->\n<p>They made our shop look like our shop.</p>\n<!-- /wp:paragraph --></blockquote>\n<!-- /wp:quote -->"]);
wpm_post(['post_title' => 'Approach', 'post_content' =>
	"<!-- wp:columns -->\n<div class=\"wp-block-columns\"><!-- wp:column -->\n<div class=\"wp-block-column\"><!-- wp:paragraph -->\n<p>Listen first.</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:column -->\n\n"
	. "<!-- wp:column -->\n<div class=\"wp-block-column\"><!-- wp:paragraph -->\n<p>Ship small.</p>\n<!-- /wp:paragraph --></div>\n<!-- /wp:column --></div>\n<!-- /wp:columns -->\n\n"
	. "<!-- wp:buttons -->\n<div class=\"wp-block-buttons\"><!-- wp:button -->\n<div class=\"wp-block-button\"><a class=\"wp-block-button__link wp-element-button\">Start a project</a></div>\n<!-- /wp:button --></div>\n<!-- /wp:buttons -->"]);

// A few posts.
foreach (['New site for the corner bakery', 'Why we stopped using sliders', 'A faster menu for Rosa\'s Diner', 'Notes on local search'] as $k => $t) {
	wpm_post(['post_type' => 'post', 'post_title' => $t, 'post_date' => '2024-0' . ($k + 6) . '-12 09:00:00',
		'post_content' => "<!-- wp:paragraph -->\n<p>$t.</p>\n<!-- /wp:paragraph -->"]);
}
PHP

# Elementor writes per-page CSS on first view; clear any cache from the seed.
wp elementor flush-css --quiet >/dev/null 2>&1 || true

hand_off_recorder_posts theo-marsh
