#!/bin/sh
# Seed the `blog` site (port 4601). Run by record.mjs inside cli-blog:
#   docker compose ... run --rm -T -e WPM_URL=http://localhost:4601 cli-blog sh /seed/seed-blog.sh
#
# 120 published posts (two REST pages at per_page=100), 3 drafts, 1 private,
# nested categories, 25 tags, 2 authors, comments, a menu with a sub-item,
# date permalinks, Yoast SEO.

. /seed/seed-common.sh

install_core "$WPM_URL" "Field Notes" "Small experiments in home cooking"
add_author dana-whitlock author "Dana Whitlock"
add_author theo-marsh editor "Theo Marsh"
plugin wordpress-seo "$WPM_YOAST_VERSION"
wp rewrite structure '/%year%/%monthnum%/%postname%/' --quiet
make_images

wp eval-file - --user=dana-whitlock <<'PHP'
<?php
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$dana = get_user_by('login', 'dana-whitlock')->ID;
$theo = get_user_by('login', 'theo-marsh')->ID;

function wpm_image($n, $title, $parent = 0) {
	$tmp = "/tmp/wpm-copy-$n-" . sanitize_title($title) . ".png";
	copy("/tmp/wpm-img-$n.png", $tmp);
	$id = media_handle_sideload(['name' => sanitize_title($title) . '.png', 'tmp_name' => $tmp], $parent, $title);
	if (is_wp_error($id)) { fwrite(STDERR, $id->get_error_message() . "\n"); exit(1); }
	return $id;
}

function wpm_term($name, $tax, $parent = 0) {
	$t = wp_insert_term($name, $tax, ['parent' => $parent]);
	return $t['term_id'];
}

// Nested categories: Guides > Beginner > Setup is three levels.
$news = wpm_term('News', 'category');
$releases = wpm_term('Releases', 'category', $news);
$guides = wpm_term('Guides', 'category');
$beginner = wpm_term('Beginner', 'category', $guides);
$setup = wpm_term('Setup', 'category', $beginner);
$opinion = wpm_term('Opinion', 'category');
$recipes = wpm_term('Recipes', 'category');
$cats = [[$news], [$releases], [$guides], [$beginner], [$setup], [$opinion], [$recipes], [$recipes, $guides]];

$tagNames = ['bread', 'sourdough', 'fermentation', 'knives', 'cast iron', 'pickles', 'soup', 'weeknight',
	'baking', 'spices', 'noodles', 'grilling', 'salads', 'breakfast', 'coffee', 'tea', 'pantry',
	'freezer', 'budget', 'kids', 'holidays', 'vegetarian', 'seafood', 'desserts', 'tools'];
$tags = array_map(fn($n) => wpm_term($n, 'post_tag'), $tagNames);

$images = [];
for ($i = 1; $i <= 6; $i++) $images[] = wpm_image($i, "Kitchen photo $i");

$adjectives = ['Quiet', 'Simple', 'Slow', 'Better', 'Honest', 'Small', 'Bright', 'Lazy', 'Sunday', 'Cheap'];
$nouns = ['Bread', 'Broth', 'Pickles', 'Pasta', 'Pancakes', 'Rice', 'Salsa', 'Dumplings', 'Granola', 'Chili', 'Biscuits', 'Curry'];

$posts = [];
$base = strtotime('2023-01-04 09:00:00');
for ($i = 1; $i <= 128; $i++) {
	$title = $adjectives[$i % 10] . ' ' . $nouns[$i % 12] . " No. $i";
	$status = $i <= 120 ? 'publish' : ($i <= 123 ? 'draft' : ($i === 124 ? 'private' : null));
	if ($status === null) break;
	$date = gmdate('Y-m-d H:i:s', $base + $i * 6 * DAY_IN_SECONDS);
	$content = "<!-- wp:paragraph -->\n<p>Notes from test kitchen batch $i. We tried it three ways and kept the one that worked on a weeknight.</p>\n<!-- /wp:paragraph -->\n\n"
		. "<!-- wp:heading -->\n<h2 class=\"wp-block-heading\">What we changed</h2>\n<!-- /wp:heading -->\n\n"
		. "<!-- wp:list -->\n<ul class=\"wp-block-list\"><!-- wp:list-item -->\n<li>Less salt</li>\n<!-- /wp:list-item -->\n\n<!-- wp:list-item -->\n<li>A hotter pan</li>\n<!-- /wp:list-item --></ul>\n<!-- /wp:list -->";
	$id = wp_insert_post([
		'post_title' => $title,
		'post_name' => sanitize_title($title),
		'post_content' => $content,
		'post_excerpt' => $i % 3 === 0 ? "A short take on batch $i." : '',
		'post_status' => $status,
		'post_date' => $date,
		'post_author' => $i % 2 ? $dana : $theo,
		'post_category' => $cats[$i % count($cats)],
		'tags_input' => [$tags[$i % 25], $tags[($i * 7) % 25]],
	], true);
	if (is_wp_error($id)) { fwrite(STDERR, $id->get_error_message() . "\n"); exit(1); }
	if ($i % 10 === 0) set_post_thumbnail($id, $images[($i / 10) % 6]);
	if ($i % 4 === 0) {
		update_post_meta($id, '_yoast_wpseo_title', "$title | Field Notes test kitchen");
		update_post_meta($id, '_yoast_wpseo_metadesc', "What we learned from batch $i.");
		update_post_meta($id, '_yoast_wpseo_focuskw', strtolower($nouns[$i % 12]));
	}
	$posts[] = $id;
}

// Pages.
$about = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'About', 'post_author' => $dana,
	'post_date' => '2023-01-02 10:00:00',
	'post_content' => "<!-- wp:paragraph -->\n<p>Two cooks, one small kitchen.</p>\n<!-- /wp:paragraph -->"]);
$start = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Start here', 'post_parent' => $about,
	'post_author' => $theo, 'post_date' => '2023-01-02 10:05:00',
	'post_content' => "<!-- wp:paragraph -->\n<p>New here? Begin with the Beginner guides.</p>\n<!-- /wp:paragraph -->"]);
$contact = wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Contact', 'post_author' => $dana,
	'post_date' => '2023-01-02 10:10:00',
	'post_content' => "<!-- wp:paragraph -->\n<p>Write to hello@example.com.</p>\n<!-- /wp:paragraph -->"]);

// Comments: two on each of the first ten posts, one reply, one pending.
$people = [['Lena Ortiz', 'lena@example.com'], ['Sam Reyes', 'sam@example.com'], ['Priya Nair', 'priya@example.com']];
foreach (array_slice($posts, 0, 10) as $k => $pid) {
	$first = 0;
	for ($c = 0; $c < 2; $c++) {
		$p = $people[($k + $c) % 3];
		$cid = wp_insert_comment(['comment_post_ID' => $pid, 'comment_author' => $p[0], 'comment_author_email' => $p[1],
			'comment_content' => "Tried this, comment $c on post $k. Worked well.", 'comment_approved' => 1,
			'comment_date' => gmdate('Y-m-d H:i:s', $base + ($k * 6 + 2 + $c) * DAY_IN_SECONDS)]);
		if ($c === 0) $first = $cid;
	}
	if ($k === 0) {
		wp_insert_comment(['comment_post_ID' => $pid, 'comment_parent' => $first, 'comment_author' => 'Dana Whitlock',
			'comment_author_email' => 'dana-whitlock@example.com', 'user_id' => $dana,
			'comment_content' => 'Thanks, glad it worked.', 'comment_approved' => 1, 'comment_date' => '2023-01-20 12:00:00']);
		wp_insert_comment(['comment_post_ID' => $pid, 'comment_author' => 'Spam Bot', 'comment_author_email' => 'bot@example.com',
			'comment_content' => 'Waiting for review.', 'comment_approved' => 0, 'comment_date' => '2023-01-21 12:00:00']);
	}
	wp_update_comment_count_now($pid);
}

// Menu with a sub-item (Guides > Beginner).
$menu = wp_create_nav_menu('Main menu');
wp_update_nav_menu_item($menu, 0, ['menu-item-title' => 'Home', 'menu-item-url' => home_url('/'), 'menu-item-type' => 'custom', 'menu-item-status' => 'publish', 'menu-item-position' => 1]);
wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $about, 'menu-item-object' => 'page', 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish', 'menu-item-position' => 2]);
$g = wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $guides, 'menu-item-object' => 'category', 'menu-item-type' => 'taxonomy', 'menu-item-status' => 'publish', 'menu-item-position' => 3]);
wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $beginner, 'menu-item-object' => 'category', 'menu-item-type' => 'taxonomy', 'menu-item-parent-id' => $g, 'menu-item-status' => 'publish', 'menu-item-position' => 4]);
wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $contact, 'menu-item-object' => 'page', 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish', 'menu-item-position' => 5]);
PHP

wp rewrite flush --quiet
# Build Yoast's indexables so its head data and sitemaps are complete.
wp yoast index --quiet >/dev/null 2>&1 || true

hand_off_recorder_posts dana-whitlock
