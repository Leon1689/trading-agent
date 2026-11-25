// Synthetic input; no model, account, market data, or credentials required.
import {priceOption} from '../packages/trading/quant.js';
const result=priceOption({model:'BLACK_SCHOLES',right:'CALL',spot:100,strike:100,timeYears:1,rate:0.05,dividendYield:0,volatility:0.2});
console.log(JSON.stringify(result,null,2));
