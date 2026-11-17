<?php
/** Read-only export. Run with WP-CLI; never install this file as a public endpoint. */
if (PHP_SAPI !== 'cli' || !defined('WP_CLI') || !WP_CLI || !function_exists('wc_get_products')) {
    fwrite(STDERR, "Run using wp eval-file with WooCommerce loaded.\n"); exit(1);
}
// Initialize registered REST controllers without issuing a request or changing data.
rest_get_server();
if (!class_exists('WC_REST_Products_Controller') || !class_exists('WC_REST_Orders_Controller')) { WP_CLI::error('WooCommerce REST controllers are unavailable.'); }
global $wpdb, $destination, $manifest;
$destination = $args[0] ?? '';
$parent = realpath(dirname($destination));
if (!$parent || $destination === '' || strpos($parent . '/', realpath(ABSPATH) . '/') === 0 || preg_match('~/(public_html|www|htdocs|public|dist)(/|$)~', $parent)) {
    WP_CLI::error('Choose a new private export directory outside the website.');
}
if (file_exists($destination) || !mkdir($destination, 0700)) { WP_CLI::error('Output directory must not exist yet.'); }
umask(0077);
$manifest = ['version'=>1, 'wordpress_version'=>get_bloginfo('version'), 'woocommerce_version'=>WC_VERSION, 'hpos_enabled'=>class_exists(\Automattic\WooCommerce\Utilities\OrderUtil::class) ? \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled() : null, 'origin'=>rtrim(set_url_scheme(home_url(), 'https'), '/'), 'started_at'=>gmdate('c'), 'currency'=>get_woocommerce_currency(), 'currency_decimals'=>wc_get_price_decimals(), 'stock_management_enabled'=>wc_string_to_bool(get_option('woocommerce_manage_stock','yes')), 'tax_enabled'=>wc_tax_enabled(), 'timezone'=>wp_timezone_string(), 'source_frozen'=>(($args[1] ?? '')==='freeze-confirmed'), 'files'=>[], 'coverage'=>['passwords_sessions'=>'excluded deliberately; never transferable', 'orders'=>'WooCommerce data API, including HPOS and refund details', 'customers'=>'business profiles only; no automatic account mapping', 'backup'=>'Separate SQL and uploads backup still required', 'hosting_inventory'=>'Owner must supply DNS/mailboxes/other sites/renewal date separately']];
function lb_scrub($value) {
    if (is_object($value) && method_exists($value, 'get_data')) { $value=$value->get_data(); }
    if (!is_array($value)) { return $value; }
    $out=[];
    foreach ($value as $k=>$v) {
        if (is_string($k) && preg_match('/password|user_pass|secret|token|order_key|session|api_key|apikey|consumer_key|access_key|private_key|auth_key|authorization|credential|payment_url|receipt_url/i', $k)) { continue; }
        if (is_array($v) && isset($v['key']) && preg_match('/password|user_pass|secret|token|order_key|session|api_key|apikey|consumer_key|access_key|private_key|auth_key|authorization|credential|payment_url|receipt_url/i', $v['key'])) { continue; }
        $out[$k]=lb_scrub($v);
    }
    return $out;
}
function lb_seo($id, $term=false) {
    $out=[];
    foreach (['title','description','canonical_url','robots','facebook_title','facebook_description','facebook_image','twitter_title','twitter_description','twitter_image','focus_keyword'] as $key) {
        $out[$key]=$term ? get_term_meta($id, 'rank_math_'.$key, true) : get_post_meta($id, 'rank_math_'.$key, true);
    }
    return $out;
}
function lb_stream($kind, $producer) {
    global $destination, $manifest;
    $file=$destination.'/'.$kind.'.jsonl'; $f=fopen($file, 'xb');
    if (!$f) { throw new RuntimeException('Cannot create private export file'); }
    chmod($file, 0600); $count=0;
    try { foreach ($producer() as $row) { $json=wp_json_encode(lb_scrub($row), JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR); if (fwrite($f, $json."\n")===false) { throw new RuntimeException('Export write failed'); } $count++; } }
    finally { fclose($f); }
    $manifest['files'][$kind]=['file'=>$kind.'.jsonl','count'=>$count,'sha256'=>hash_file('sha256',$file)];
}
try {
    lb_stream('products', function() {
        $controller=new WC_REST_Products_Controller(); $request=new WP_REST_Request('GET');
        for ($page=1;;$page++) {
            $result=wc_get_products(['limit'=>100,'page'=>$page,'paginate'=>true,'orderby'=>'ID','order'=>'ASC','status'=>array_keys(get_post_stati())]);
            foreach ($result->products as $product) {
                $row=$controller->prepare_object_for_response($product,$request)->get_data();
                $row['parent_id']=$product->get_parent_id(); $row['protected_content']=(get_post_field('post_password',$product->get_id())!==''); $row['seo']=lb_seo($product->get_id()); yield $row;
                foreach ($product->is_type('variable') ? $product->get_children() : [] as $id) {
                    $variant=wc_get_product($id); if (!$variant) { throw new RuntimeException('Variation vanished during export; repeat export'); }
                    $vc=new WC_REST_Product_Variations_Controller(); $vr=new WP_REST_Request('GET'); $vr->set_param('product_id',$product->get_id());
                    $v=$vc->prepare_object_for_response($variant,$vr)->get_data(); $v['type']='variation'; $v['slug']=$variant->get_slug() ?: 'variation-'.$id; $v['parent_id']=$product->get_id(); yield $v;
                }
            }
            if ($page >= $result->max_num_pages) { break; }
        }
    });
    foreach (['categories'=>'product_cat','tags'=>'product_tag'] as $kind=>$taxonomy) {
        lb_stream($kind, function() use($taxonomy) {
            for ($offset=0;;$offset+=100) {
                $rows=get_terms(['taxonomy'=>$taxonomy,'hide_empty'=>false,'number'=>100,'offset'=>$offset,'orderby'=>'term_id','order'=>'ASC']);
                if (is_wp_error($rows)) { throw new RuntimeException('Term export failed'); }
                foreach ($rows as $term) {
                    $id=get_term_meta($term->term_id,'thumbnail_id',true);
                    yield ['id'=>$term->term_id,'name'=>$term->name,'slug'=>$term->slug,'parent'=>$term->parent,'count'=>$term->count,'description'=>$term->description,'link'=>get_term_link($term),'seo'=>lb_seo($term->term_id,true),'image'=>$id ? ['src'=>wp_get_attachment_url($id),'alt'=>get_post_meta($id,'_wp_attachment_image_alt',true)] : null];
                }
                if (count($rows)<100) { break; }
            }
        });
    }
    foreach (['pages'=>'page','posts'=>'post','attachments'=>'attachment'] as $kind=>$type) {
        lb_stream($kind,function() use($type) {
            for ($page=1;;$page++) {
                $rows=get_posts(['post_type'=>$type,'post_status'=>array_keys(get_post_stati()),'posts_per_page'=>100,'paged'=>$page,'orderby'=>'ID','order'=>'ASC']);
                foreach ($rows as $p) {
                    yield ['id'=>$p->ID,'protected_content'=>($p->post_password!==''),'slug'=>$p->post_name,'status'=>$p->post_status,'title'=>['raw'=>$p->post_title],'content'=>['raw'=>$p->post_content],'excerpt'=>['raw'=>$p->post_excerpt],'date_gmt'=>$p->post_date_gmt,'modified_gmt'=>$p->post_modified_gmt,'link'=>get_permalink($p),'source_url'=>$type==='attachment' ? wp_get_attachment_url($p->ID) : null,'media_details'=>$type==='attachment' ? wp_get_attachment_metadata($p->ID) : null,'seo'=>lb_seo($p->ID)];
                }
                if (count($rows)<100) { break; }
            }
        });
    }
    lb_stream('orders',function() {
        $controller=new WC_REST_Orders_Controller(); $request=new WP_REST_Request('GET');
        for ($page=1;;$page++) {
            $rows=wc_get_orders(['limit'=>100,'page'=>$page,'paginate'=>true,'orderby'=>'ID','order'=>'ASC','status'=>array_merge(array_keys(wc_get_order_statuses()),['trash'])]);
            foreach ($rows->orders as $o) {
                $row=$controller->prepare_object_for_response($o,$request)->get_data();
                $row['legacy_stock_reduced']=wc_string_to_bool($o->get_data_store()->get_stock_reduced($o->get_id()));
                $row['legacy_notes']=array_map(function($n){return (array)$n;},wc_get_order_notes(['order_id'=>$o->get_id()]));
                $row['legacy_refunds']=array_map(function($r){return $r->get_data();},$o->get_refunds()); yield $row;
            }
            if ($page >= $rows->max_num_pages) { break; }
        }
    });
    lb_stream('customers',function() {
        for ($offset=0;;$offset+=100) {
            $ids=get_users(['number'=>100,'offset'=>$offset,'fields'=>'ID','orderby'=>'ID','order'=>'ASC']);
            foreach ($ids as $id) { $customer=new WC_Customer($id); yield $customer->get_data(); }
            if (count($ids)<100) { break; }
        }
    });
    lb_stream('redirects',function() {
        global $wpdb;
        $table=$wpdb->prefix.'rank_math_redirections';
        if ($wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s',$wpdb->esc_like($table)))!==$table) { return; }
        for ($offset=0;;$offset+=100) {
            $rows=$wpdb->get_results("SELECT * FROM `".str_replace('`','',$table)."` ORDER BY id LIMIT 100 OFFSET ".intval($offset),ARRAY_A);
            if ($wpdb->last_error) { throw new RuntimeException('Rank Math redirects export failed'); }
            foreach ($rows as $row) { yield $row; }
            if (count($rows)<100) { break; }
        }
    });
    $settings=['logo'=>wp_get_attachment_url(get_theme_mod('custom_logo')) ?: '', 'icon'=>get_site_icon_url(), 'header_image'=>get_header_image(), 'background_image'=>get_background_image(), 'name'=>get_bloginfo('name'),'description'=>get_bloginfo('description'),'language'=>get_bloginfo('language'),'timezone'=>wp_timezone_string(),'currency'=>get_woocommerce_currency(),'currency_decimals'=>wc_get_price_decimals()];
    file_put_contents($destination.'/site-settings.json',wp_json_encode($settings,JSON_THROW_ON_ERROR));
    $manifest['settings_sha256']=hash_file('sha256',$destination.'/site-settings.json');
    $manifest['finished_at']=gmdate('c');
    file_put_contents($destination.'/manifest.json',wp_json_encode($manifest,JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));
    WP_CLI::success('Private export complete. Download the entire folder securely; keep WordPress running.');
} catch (Throwable $e) {
    WP_CLI::error('Export incomplete. Keep this private directory for diagnosis and rerun into a new directory. '.$e->getMessage());
}
