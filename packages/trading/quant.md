# Quant and risk reference

The functions in `quant.js` are deterministic calculations and do not read accounts, fetch prices, mutate the existing options ledger or authorize orders. Numeric pricing outputs use floating point and carry model assumptions. Wheel money and share comparisons use exact scaled integers with up to six decimal input places. The existing ledger remains the owner of confirmed cash flows and assignment posting.

## Pricing and scenarios

`priceOption({model,right,spot,strike,timeYears,rate,dividendYield,volatility,steps?})` accepts `BLACK_SCHOLES` for European exercise or `CRR` for American exercise. `right` is `CALL` or `PUT`; rates, continuous dividend yield and volatility are absolute decimals. CRR requires an integer `steps` from 3 to 2000. Missing assumptions fail explicitly. Discrete dividends and adjusted deliverables are unsupported. CRR checks the risk-neutral probability and reports unstable inputs instead of clamping probabilities.

The result contains `price`, `greeks`, `model`, `modelVersion`, `exerciseStyle`, `assumptions`, `units`, `warnings`, and `executableQuote:false`. Price is per underlying unit. Delta is underlying units per option unit; Gamma is Delta per one currency spot change; Theta is the annual derivative divided by 365; Vega and Rho represent absolute IV/rate changes of 0.01. Expired or zero-volatility degenerate cases return null for undefined Greeks. CRR Greeks are finite-lattice estimates and need convergence review for the selected contract. Neither model estimates assignment probability.

`impliedVolatility({...pricingAssumptions,targetPrice,minVol,maxVol,tolerance,maxIterations})` requires an explicit positive IV bracket and price tolerance. It returns `converged:true`, solved `volatility`, residual and pricing output, or `converged:false,volatility:null` at the iteration limit. A price outside the bracket, expired option or unstable tree fails explicitly.

`optionScenario({option,signedContracts,multiplier,shocks})` takes shocks `{spotChangePct,volatilityChange,daysElapsed}`. `spotChangePct:0.1` means +10% and `volatilityChange:0.01` means +1 IV percentage point. Results contain the base and shocked price, signed position value and hypothetical P/L. These are model mark-to-market differences and do not account for exercise cash flows, financing, commissions or taxes.

CRR requests have a deterministic operational ceiling of 50,000,000 estimated lattice updates across an entire scenario or IV request, including pricing Greeks. Oversized requests fail before the loop with `COMPUTE_BUDGET_EXCEEDED`; reduce the requested steps, scenarios or solver iteration budget. This bounds synchronous CPU work independently of HTTP body size and does not change investment assumptions.

```json
{
  "model": "BLACK_SCHOLES",
  "right": "CALL",
  "spot": "100",
  "strike": "100",
  "timeYears": 0.0821917808219178,
  "rate": 0.05,
  "dividendYield": 0,
  "volatility": 0.2
}
```

This fixed input produces price `2.4933768194`, Delta `0.5399635456`, Gamma `0.0692276405`, Theta/day `-0.0449881561` and Vega/IV percentage point `0.1137988610`.

## Wheel checks

`analyzeWheel(input)` requires `strategy:'CC'|'CSP'`, `symbol`, `currency`, `candidates`, `existingObligations`, and explicit verification/risk fields. All proposed candidates must use the requested strategy and symbol. Each candidate/obligation has `id,strategy,symbol,currency,contracts,multiplier,strike`; proposed candidates additionally need `standardDeliverableVerified:true`. Repeated identical source IDs count once; conflicting duplicate IDs or IDs reused across input collections fail. Different IDs are not deduplicated by matching amounts.

CC input uses `position:{shares,nominalCost,netPremium,confirmed}` and `stockReservations:[{id,symbol,shares}]`. Current option obligations and stock-sale reservations are deducted together. The whole candidate set is then checked against remaining shares. `K>C` is compared exactly against confirmed pre-trade cost; quoted future premium never lowers that threshold. Zero shares yield null per-share cost; negative strategy cost is preserved.

CSP input uses `cash:{amount,basis:'GROSS_SETTLED',confirmed}`, `cashBuffer` and `estimatedFees`. Cash must be gross settled cash before the listed obligation reserves. Every current and proposed CSP across symbols is included, fees and buffer are deducted once, and unsupported currency mixing remains unknown. Missing obligation/reservation arrays mean unknown; an explicit empty array represents known none.

`dataQuality:{fresh,reconciled,complete}` must be verified true, while `riskChecks:{willingToTakeAssignment,batchPolicyConfirmed,liquidity,eventRisk,concentration}` records explicit checked policies. CC requires batch policy confirmation. Liquidity, event risk and concentration accept `PASS/FAIL/UNKNOWN` or booleans. These flags are **caller attestations**: the service must derive them from confirmed context, or label the result hypothetical. A model setting flags does not establish broker verification.

The result contains `decision`, per-check states, known blocking reasons, unresolved review reasons, current cost/share fields, and cash coverage. Known hard failures dominate unknowns; otherwise missing data yields `MANUAL_REVIEW`. `ALLOW` is analysis-only and always carries `orderSubmissionEnabled:false`.

## Portfolio risk

`portfolioRisk({currency,cash,positions})` accepts positions `{id,symbol,assetClass,signedQuantity,price,multiplier?,underlyingSpot?,greeks?,sector?,currency?}`. Here `symbol` denotes the underlying; `id` distinguishes contracts. Option Greeks must use the pricing units above, signed option quantity is integer contracts, and multiplier must be known. Stock multiplier is one. Mixed currencies are rejected rather than implicitly converted.

The output includes marked equity, gross exposure, sector gross weights, per-position signed Greeks, `greeksByUnderlying` and net dollar Delta. Share Delta is not summed across different underlying symbols. Missing component Greeks propagate null to the respective total; unknown prices or underlying spots remain explicit. Dollar Delta is first-order exposure for a 100% relative price move, not a forecast loss. Sector weights divide by gross absolute marked position value and exclude cash.

## Backtests

`backtestPortfolio({initialCapital,weights,series,seriesKind,dataFrequency,rebalance,costBps,annualRiskFreeRate,periodsPerYear,benchmarkSymbol?,expectedDates?})` consumes aligned `{date,adjustedClose}` arrays keyed by symbol. `seriesKind` must be `ADJUSTED_TOTAL_RETURN`. `dataFrequency` is `DAILY` or `ANNUAL`, and rebalancing is `MONTHLY`, `ANNUAL` or `NONE`; monthly requires daily observations. Annual data requires `periodsPerYear:1`. Prices must already incorporate dividend total returns; dividends are not added again. Weights are long-only, sum to `(0,1]`, and the residual is zero-yield cash. Tunable costs and risk-free rate must be supplied, including explicit zeros.

Initial allocation occurs at the first supplied close. A rebalance occurs at the last supplied close before a month/year boundary; new holdings affect only subsequent returns. The cost equation solves target holdings after proportional costs on absolute traded notional, including the initial allocation. There is no forced terminal liquidation. Adjusted units are synthetic research units, not executable share quantities. Taxes are not modelled.

The result contains `equityCurve`, rebalance `trades`, `totalCosts`, metrics and an optional buy-and-hold benchmark. Both strategies pay the same initial cost rate. CAGR uses actual elapsed days divided by 365.25. Sharpe uses subsequent observation returns, sample standard deviation and the caller-specified periods per year; the geometric per-period risk-free rate is subtracted. Initial allocation cost affects total return but is not inserted as an extra Sharpe observation. Sharpe is null when variance is zero or fewer than two returns exist. Drawdown includes initial costs and only measures supplied observations; annual samples cannot establish daily drawdown.

Dates must be strictly increasing, unique and exactly aligned across assets. No forward fill occurs. Daily data with a gap longer than ten calendar days is rejected as insufficient history. `expectedDates` can validate the full caller-supplied trading calendar; without it only cross-asset alignment is established. The module cannot verify whether a vendor's series is survivorship-free or genuinely adjusted total-return data. Historical data source and entitlement checks belong to the service/provider.

## Option screening

`rankOptions({candidates,criteria,limit})` requires explicit `minAbsDelta,maxAbsDelta,maxRelativeSpread,minOpenInterest,minVolume`. It filters known bid/ask, absolute Delta, open interest and volume, then ranks by narrower relative spread and larger open interest. Missing fields enter `review`; zero or crossed quotes are rejected. The output limit is enforced. Screening is a liquidity/Delta filter and does not check the complete Wheel, expiry, source freshness or assignment suitability.

## Validation

Run `node --test packages/trading/test/quant.test.js`. Tests cover independent fixed pricing values, put-call parity, central finite differences, American exercise/convergence, IV inversion, signed exposure, strict cost and aggregate coverage, missing data, exact duplicate IDs, no-lookahead monthly rebalancing, cost conservation and the supplied annual return regression (`15322.61`, not `16823`). These tests validate calculations on supplied inputs, not market history or trading profitability.
