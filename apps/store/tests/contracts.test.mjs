import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateBundle} from '../src/lib/contracts.mjs';
const product=()=>({id:1,slug:'কুকার',name:'Cooker',price:1000,regular:1000,cats:['kitchen'],tags:[],images:[],attrs:[]});
const store=()=>({site:{},cats:[{slug:'kitchen'}],tags:[],pages:[],posts:[]});
test('bundle contract rejects ambiguous identities, prices and references',()=>{
 validateBundle([product()],store());
 for(const patch of [{price:1.5},{price:1e20},{slug:'%2f'},{cats:['unknown']},{attrs:null}])assert.throws(()=>validateBundle([{...product(),...patch}],store()));
 assert.throws(()=>validateBundle([product(),product()],store()));
});
