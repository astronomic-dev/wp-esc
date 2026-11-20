# Shared helpers for the seed scripts. Sourced, not run.
# Runs inside a cli-* container (WP-CLI, uid 33) with this folder at /seed.

set -eu
# Pinned plugin versions (WPM_*_VERSION).
. /seed/versions.env

# The account record.mjs gives an application password. It owns no content,
# and its public slug differs from its login, so the login never shows up in
# REST, HTML or WXR. fixtures.test.ts fails if it ever does.
RECORDER=wpm-recorder

install_core() {
	url=$1
	title=$2
	tagline=$3
	wp core install --url="$url" --title="$title" --admin_user="$RECORDER" \
		--admin_email=recorder@example.com --skip-email --quiet \
		--admin_password="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
	wp user update "$RECORDER" --user_nicename=site-admin --display_name="Site Admin" \
		--nickname="Site Admin" --quiet
	wp option update blogdescription "$tagline" --quiet
	wp option update admin_email owner@example.com --quiet
	wp option update timezone_string America/Denver --quiet
	wp option update date_format "F j, Y" --quiet
	# Drop the stock post, page and privacy draft, and the bundled plugins.
	ids=$(wp post list --post_type=any --post_status=any --format=ids)
	[ -n "$ids" ] && wp post delete $ids --force --quiet
	wp plugin delete akismet hello --quiet
}

add_author() {
	# Content authors: login equals the public slug, as on most real sites.
	wp user create "$1" "$1@example.com" --role="$2" --display_name="$3" \
		--first_name="${3% *}" --last_name="${3#* }" --quiet \
		--user_pass="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
}

plugin() {
	wp plugin install "$1" --version="$2" --activate --quiet
}

# Write a few solid-color PNGs to /tmp/wpm-img-<n>.png for media imports.
make_images() {
	wp eval '
		$colors = [[38,70,83],[42,157,143],[233,196,106],[244,162,97],[231,111,81],[69,123,157]];
		foreach ($colors as $i => $c) {
			$im = imagecreatetruecolor(1200, 800);
			imagefill($im, 0, 0, imagecolorallocate($im, $c[0], $c[1], $c[2]));
			imagepng($im, "/tmp/wpm-img-" . ($i + 1) . ".png");
		}
	'
}

# Hand anything the install made as the recorder (global styles, kits) to a
# content author, so the recorder login stays out of the WXR export.
# It also makes the theme's user global styles post now: WordPress creates it
# lazily, and an authenticated GET /wp/v2/themes does that as a side effect,
# which would make the recorder its author.
hand_off_recorder_posts() {
	wp eval 'WP_Theme_JSON_Resolver::get_user_global_styles_post_id();' --user="$1"
	wp eval '
		global $wpdb;
		$from = get_user_by("login", "'"$RECORDER"'")->ID;
		$to = get_user_by("login", "'"$1"'")->ID;
		$wpdb->update($wpdb->posts, ["post_author" => $to], ["post_author" => $from]);
		clean_post_cache(0);
	'
}
