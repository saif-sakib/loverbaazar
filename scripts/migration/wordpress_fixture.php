<?php
// Disposable source fixtures only. This is never a live-site migration command.
if (!defined('WP_CLI') || !WP_CLI || get_option('blogname') !== 'LoverBaazar export fixture') { throw new RuntimeException('Fixture guard refused'); }
update_option('woocommerce_currency','BDT'); update_option('woocommerce_calc_taxes','no'); update_option('woocommerce_manage_stock','yes');
$term=wp_insert_term('Fixture kitchen','product_cat',['slug'=>'fixture-kitchen']);
for ($i=1;$i<=103;$i++) {
    $p=new WC_Product_Simple(); $p->set_name('Fixture product '.$i); $p->set_slug('fixture-product-'.$i); $p->set_regular_price('1250'); $p->set_manage_stock(true); $p->set_stock_quantity(3); $p->set_category_ids([$term['term_id']]); $p->set_status('publish'); $p->save();
    if ($i===1) { $first=$p; update_post_meta($p->get_id(),'rank_math_title','Fixture preserved SEO'); }
}
$variable=new WC_Product_Variable(); $variable->set_name('Fixture variable'); $variable->set_slug('fixture-variable'); $variable->set_status('publish');
$attribute=new WC_Product_Attribute(); $attribute->set_name('Colour'); $attribute->set_options(['Red','Blue']); $attribute->set_variation(true); $variable->set_attributes([$attribute]); $variable->save();
$variation=new WC_Product_Variation(); $variation->set_parent_id($variable->get_id()); $variation->set_attributes(['colour'=>'Red']); $variation->set_regular_price('100'); $variation->set_sku('FIXTURE-RED'); $variation->set_manage_stock(true); $variation->set_stock_quantity(2); $variation->set_status('publish'); $variation->save();
$customer=new WC_Customer(); $customer->set_username('fixture-buyer'); $customer->set_email('buyer@example.invalid'); $customer->set_billing_phone('01710000000'); $customer->set_password('Local-fixture-password-not-a-real-account'); $customer->save();
$order=wc_create_order(['customer_id'=>$customer->get_id()]); $order->set_currency('BDT'); $order->add_product($first,1); $order->set_billing_phone('01710000000'); $order->calculate_totals(); $order->update_status('processing');
wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'পরীক্ষার পাতা','post_name'=>'fixture-page','post_content'=>'<p>পরীক্ষার বিষয়বস্তু</p>']);
wp_insert_post(['post_type'=>'page','post_status'=>'publish','post_title'=>'Protected fixture','post_name'=>'protected-fixture','post_password'=>'Do-not-export-this-fixture-password','post_content'=>'Private fixture text']);
WP_CLI::success('Synthetic WordPress source created.');
