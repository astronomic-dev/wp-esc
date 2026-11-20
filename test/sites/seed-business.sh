#!/bin/sh
# Seed the `business` site (port 4602), installed in the subdirectory /site/.
# Run by record.mjs inside cli-business (working dir /var/www/html/site):
#   docker compose ... run --rm -T -e WPM_URL=http://localhost:4602/site cli-business sh /seed/seed-business.sh
#
# A page tree 3 levels deep with one slug (`pricing`) under two parents;
# `service` (in REST) and `team` (not in REST) types; a `service_area`
# taxonomy; Secure Custom Fields groups stored in the database (text, image,
# relationship, a sparse field, a repeater); Contact Form 7 with Flamingo
# storing messages; /%postname%/ permalinks.

. /seed/seed-common.sh

install_core "$WPM_URL" "Harbor Light Home Services" "Repairs and upkeep for homes and shops"
add_author dana-whitlock editor "Dana Whitlock"

# Subdirectory rewrite rules, with the Authorization pass-through the
# application password needs.
cat > .htaccess <<'HT'
# BEGIN WordPress
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /site/
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /site/index.php [L]
# END WordPress
HT

mkdir -p wp-content/mu-plugins
cp /seed/mu-plugins/business-types.php wp-content/mu-plugins/
plugin secure-custom-fields "$WPM_SCF_VERSION"
plugin contact-form-7 "$WPM_CF7_VERSION"
plugin flamingo "$WPM_FLAMINGO_VERSION"
wp rewrite structure '/%postname%/' --quiet
make_images

wp eval-file - --user=dana-whitlock <<'PHP'
<?php
require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';

$dana = get_current_user_id();

function wpm_fail($e) { fwrite(STDERR, (is_wp_error($e) ? $e->get_error_message() : $e) . "\n"); exit(1); }
function wpm_image($n, $title) {
	$tmp = "/tmp/wpm-copy-" . sanitize_title($title) . ".png";
	copy("/tmp/wpm-img-$n.png", $tmp);
	$id = media_handle_sideload(['name' => sanitize_title($title) . '.png', 'tmp_name' => $tmp], 0, $title);
	if (is_wp_error($id)) wpm_fail($id);
	return $id;
}
function wpm_post($args) {
	$id = wp_insert_post($args + ['post_status' => 'publish'], true);
	if (is_wp_error($id)) wpm_fail($id);
	return $id;
}
function wpm_page($title, $parent = 0, $content = '', $slug = '') {
	return wpm_post(['post_type' => 'page', 'post_title' => $title, 'post_name' => $slug ?: sanitize_title($title),
		'post_parent' => $parent, 'post_date' => '2024-03-01 09:00:00',
		'post_content' => $content ?: "<!-- wp:paragraph -->\n<p>$title at Harbor Light.</p>\n<!-- /wp:paragraph -->"]);
}

$images = [];
for ($i = 1; $i <= 6; $i++) $images[] = wpm_image($i, "Harbor Light photo $i");

// Contact Form 7: use the form made on activation, or make one.
$forms = get_posts(['post_type' => 'wpcf7_contact_form', 'numberposts' => 1]);
if ($forms) { $form = wpcf7_contact_form($forms[0]->ID); }
else { $form = WPCF7_ContactForm::get_template(['title' => 'Contact form 1']); $form->save(); }

// Page tree: three levels, `pricing` under both Residential and Commercial.
$home = wpm_page('Home', 0, "<!-- wp:paragraph -->\n<p>Repairs and upkeep for homes and shops on the coast.</p>\n<!-- /wp:paragraph -->");
$servicesPage = wpm_page('What we do');
$residential = wpm_page('Residential', $servicesPage);
$commercial = wpm_page('Commercial', $servicesPage);
wpm_page('Pricing', $residential, "<!-- wp:paragraph -->\n<p>Home rates start at \$95 an hour.</p>\n<!-- /wp:paragraph -->", 'pricing');
wpm_page('Pricing', $commercial, "<!-- wp:paragraph -->\n<p>Shop rates start at \$140 an hour.</p>\n<!-- /wp:paragraph -->", 'pricing');
wpm_page('Repairs', $residential);
$company = wpm_page('Company');
$aboutPage = wpm_page('About us', $company);
wpm_page('History', $aboutPage);
wpm_page('Careers', $company);
$contact = wpm_page('Contact', 0, "<!-- wp:paragraph -->\n<p>Tell us what needs fixing.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:shortcode -->\n" . $form->shortcode() . "\n<!-- /wp:shortcode -->");
$newsPage = wpm_page('News');
update_option('show_on_front', 'page');
update_option('page_on_front', $home);
update_option('page_for_posts', $newsPage);

foreach (['Spring checklist for older homes', 'We now serve Bayview', 'How to winterize an outdoor faucet'] as $k => $t) {
	wpm_post(['post_title' => $t, 'post_date' => "2024-0" . ($k + 4) . "-10 09:00:00",
		'post_content' => "<!-- wp:paragraph -->\n<p>$t.</p>\n<!-- /wp:paragraph -->"]);
}

// Service areas.
$areas = [];
foreach (['Residential', 'Commercial', 'Emergency'] as $a) $areas[$a] = wp_insert_term($a, 'service_area')['term_id'];
$areas['Same day'] = wp_insert_term('Same day', 'service_area', ['parent' => $areas['Emergency']])['term_id'];

// Secure Custom Fields groups, stored as acf-field-group and acf-field posts.
acf_import_field_group([
	'key' => 'group_wpm_service', 'title' => 'Service details',
	'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'service']]],
	'show_in_rest' => 1,
	'fields' => [
		['key' => 'field_wpm_tagline', 'name' => 'tagline', 'label' => 'Tagline', 'type' => 'text'],
		['key' => 'field_wpm_hero', 'name' => 'hero_image', 'label' => 'Hero image', 'type' => 'image', 'return_format' => 'id'],
		['key' => 'field_wpm_related', 'name' => 'related_services', 'label' => 'Related services', 'type' => 'relationship',
			'post_type' => ['service'], 'return_format' => 'id'],
		['key' => 'field_wpm_warranty', 'name' => 'warranty_note', 'label' => 'Warranty note', 'type' => 'textarea'],
		['key' => 'field_wpm_faq', 'name' => 'faq', 'label' => 'Questions', 'type' => 'repeater', 'layout' => 'table',
			'sub_fields' => [
				['key' => 'field_wpm_faq_q', 'name' => 'question', 'label' => 'Question', 'type' => 'text'],
				['key' => 'field_wpm_faq_a', 'name' => 'answer', 'label' => 'Answer', 'type' => 'textarea'],
			]],
	],
]);
acf_import_field_group([
	'key' => 'group_wpm_team', 'title' => 'Team profile',
	'location' => [[['param' => 'post_type', 'operator' => '==', 'value' => 'team']]],
	'fields' => [
		['key' => 'field_wpm_job', 'name' => 'job_title', 'label' => 'Job title', 'type' => 'text'],
		['key' => 'field_wpm_headshot', 'name' => 'headshot', 'label' => 'Headshot', 'type' => 'image', 'return_format' => 'id'],
		['key' => 'field_wpm_team_services', 'name' => 'team_services', 'label' => 'Services', 'type' => 'relationship',
			'post_type' => ['service'], 'return_format' => 'id'],
		['key' => 'field_wpm_creds', 'name' => 'credentials', 'label' => 'Credentials', 'type' => 'repeater',
			'sub_fields' => [
				['key' => 'field_wpm_creds_name', 'name' => 'credential', 'label' => 'Credential', 'type' => 'text'],
				['key' => 'field_wpm_creds_year', 'name' => 'year', 'label' => 'Year', 'type' => 'number'],
			]],
	],
]);

// Services.
$serviceNames = [['Leak repair', 'Residential'], ['Water heater service', 'Residential'], ['Drywall patching', 'Residential'],
	['Storefront doors', 'Commercial'], ['Lighting retrofits', 'Commercial'], ['Roof tarping', 'Same day'],
	['Gutter cleaning', 'Residential'], ['Snow removal', 'Commercial']];
$services = [];
foreach ($serviceNames as $k => [$name, $area]) {
	$id = wpm_post(['post_type' => 'service', 'post_title' => $name, 'post_date' => "2024-02-" . sprintf('%02d', $k + 1) . " 09:00:00",
		'post_excerpt' => "$name, done right.",
		'post_content' => "<!-- wp:paragraph -->\n<p>$name for the Harbor Light area.</p>\n<!-- /wp:paragraph -->"]);
	wp_set_object_terms($id, [$areas[$area]], 'service_area');
	set_post_thumbnail($id, $images[$k % 6]);
	$services[] = $id;
}
foreach ($services as $k => $id) {
	update_field('field_wpm_tagline', $serviceNames[$k][0] . ' without the wait', $id);
	update_field('field_wpm_hero', $images[($k + 1) % 6], $id);
	update_field('field_wpm_related', [$services[($k + 1) % 8], $services[($k + 2) % 8]], $id);
	if ($k === 0) update_field('field_wpm_warranty', 'Parts and labor covered for one year.', $id); // sparse: 1 of 8
	$rows = [];
	for ($r = 0; $r < 1 + $k % 3; $r++) $rows[] = ['field_wpm_faq_q' => "Question $r about " . $serviceNames[$k][0] . '?', 'field_wpm_faq_a' => "Answer $r."];
	update_field('field_wpm_faq', $rows, $id);
}

// Team (not in REST).
$people = [['Ines Duarte', 'Owner'], ['Marcus Bell', 'Lead technician'], ['Hana Sato', 'Electrician'], ['Owen Price', 'Office manager'], ['Rosa Lind', 'Apprentice']];
foreach ($people as $k => [$name, $job]) {
	$id = wpm_post(['post_type' => 'team', 'post_title' => $name, 'post_date' => "2024-01-" . sprintf('%02d', $k + 10) . " 09:00:00",
		'post_content' => "<!-- wp:paragraph -->\n<p>$name has been with Harbor Light since " . (2015 + $k) . ".</p>\n<!-- /wp:paragraph -->"]);
	update_field('field_wpm_job', $job, $id);
	update_field('field_wpm_headshot', $images[$k], $id);
	update_field('field_wpm_team_services', [$services[$k], $services[$k + 3]], $id);
	$creds = [];
	for ($r = 0; $r < $k % 3; $r++) $creds[] = ['field_wpm_creds_name' => "License $r", 'field_wpm_creds_year' => 2018 + $r];
	update_field('field_wpm_creds', $creds, $id);
}

// Flamingo: three stored form messages, as if sent through the contact form.
$senders = [['Lena Ortiz', 'lena@example.com'], ['Sam Reyes', 'sam@example.com'], ['Priya Nair', 'priya@example.com']];
foreach ($senders as $k => [$name, $email]) {
	Flamingo_Contact::add(['email' => $email, 'name' => $name]);
	Flamingo_Inbound_Message::add([
		'channel' => 'contact-form-1', 'subject' => "Quote request $k",
		'from' => "$name <$email>", 'from_name' => $name, 'from_email' => $email,
		'fields' => ['your-name' => $name, 'your-email' => $email, 'your-subject' => "Quote request $k", 'your-message' => 'Can you look at a leak?'],
	]);
}

// Menu with a sub-item.
$menu = wp_create_nav_menu('Primary');
$w = wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $servicesPage, 'menu-item-object' => 'page', 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish']);
wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $residential, 'menu-item-object' => 'page', 'menu-item-type' => 'post_type', 'menu-item-parent-id' => $w, 'menu-item-status' => 'publish']);
wp_update_nav_menu_item($menu, 0, ['menu-item-object' => 'service', 'menu-item-type' => 'post_type_archive', 'menu-item-title' => 'All services', 'menu-item-status' => 'publish']);
wp_update_nav_menu_item($menu, 0, ['menu-item-object-id' => $contact, 'menu-item-object' => 'page', 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish']);
PHP

wp rewrite flush --quiet

hand_off_recorder_posts dana-whitlock
