/* =====================================================================
 * Vriddhi Fuels — a day's vouchers as Tally Prime's own Day Book files.
 * ---------------------------------------------------------------------
 * xml():   the Day Book XML export (Gateway → Display → Day Book → Export →
 *          XML), byte for byte: UTF-16 with BOM, CRLF, Tally's field order,
 *          its empty placeholder lists and &#4; markers. The template is
 *          Tally's own export of a HSD CREDIT invoice with the values made
 *          placeholders; what Tally takes from the customer ledger (address,
 *          PAN, VAT dealer type, GST details) comes from the Master import.
 *          Tally's internal keys (VCHKEY, MASTERID, VOUCHERKEY) are left out
 *          when the app does not know them — GUID and ALTERID come from the
 *          bridge.
 * excel(): the Day Book exported to Excel ("Sales Register" sheet) — the
 *          file the Ledger app's Import Sales reads: same cells, styles,
 *          number formats and merges as Tally's export.
 * Pure; no DOM — also runs under Node (tests/ledger_web/tally_daybook.test.mjs).
 * ===================================================================== */
(function (global) {
"use strict";

// What Tally puts on each fuel voucher's stock line (from its own export).
var SERIES = {
  hsd: { vt: "HSD CREDIT", item: "High Speed Diesel", sales: "SALE (HSD)", taxability: "Nil Rated", hsn: "27101944", hsnDescription: "" },
  ms:  { vt: "MS CREDIT",  item: "Motor Spirit",      sales: "SALE (MS)",  taxability: "Non-GST",   hsn: "27101243", hsnDescription: "Petrol" },
  // XtraGreen books to SALE (HSD), as diesel
  xg:  { vt: "XG CREDIT",  item: "XtraGreen Diesel",  sales: "SALE (HSD)", taxability: "Nil Rated", hsn: "27101944", hsnDescription: "" }
};
var ORDER = ["hsd", "ms", "xg"];

// Tally's export of one invoice. "?key|" lines print only when the value is
// known; "@" lines are blocks built in code.
var VOUCHER = [
"@VOUCHER",
"@ADDRESS",
"      <OLDAUDITENTRYIDS.LIST TYPE=\"Number\">",
"       <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>",
"      </OLDAUDITENTRYIDS.LIST>",
"      <DATE>{{date}}</DATE>",
"      <VCHSTATUSDATE>{{date}}</VCHSTATUSDATE>",
"?guid|      <GUID>{{guid}}</GUID>",
"      <GSTREGISTRATIONTYPE>{{regType}}</GSTREGISTRATIONTYPE>",
"?vatDealerType|      <VATDEALERTYPE>{{vatDealerType}}</VATDEALERTYPE>",
"      <STATENAME>{{state}}</STATENAME>",
"      <COUNTRYOFRESIDENCE>{{country}}</COUNTRYOFRESIDENCE>",
"?gstin|      <PARTYGSTIN>{{gstin}}</PARTYGSTIN>",
"      <PLACEOFSUPPLY>{{place}}</PLACEOFSUPPLY>",
"      <VOUCHERTYPENAME>{{vt}}</VOUCHERTYPENAME>",
"      <PARTYNAME>{{party}}</PARTYNAME>",
"      <GSTREGISTRATION TAXTYPE=\"GST\" TAXREGISTRATION=\"21AATFV8250A1Z8\">Odisha Registration</GSTREGISTRATION>",
"      <CMPGSTIN>21AATFV8250A1Z8</CMPGSTIN>",
"      <PARTYLEDGERNAME>{{party}}</PARTYLEDGERNAME>",
"      <VOUCHERNUMBER>{{number}}</VOUCHERNUMBER>",
"      <BASICBUYERNAME>{{party}}</BASICBUYERNAME>",
"      <CMPGSTREGISTRATIONTYPE>Regular</CMPGSTREGISTRATIONTYPE>",
"      <PARTYMAILINGNAME>{{party}}</PARTYMAILINGNAME>",
"?pincode|      <PARTYPINCODE>{{pincode}}</PARTYPINCODE>",
"?gstin|      <CONSIGNEEGSTIN>{{gstin}}</CONSIGNEEGSTIN>",
"      <CONSIGNEEMAILINGNAME>{{party}}</CONSIGNEEMAILINGNAME>",
"?pincode|      <CONSIGNEEPINCODE>{{pincode}}</CONSIGNEEPINCODE>",
"      <CONSIGNEESTATENAME>{{state}}</CONSIGNEESTATENAME>",
"      <CMPGSTSTATE>Odisha</CMPGSTSTATE>",
"      <CONSIGNEECOUNTRYNAME>{{country}}</CONSIGNEECOUNTRYNAME>",
"      <BASICBASEPARTYNAME>{{party}}</BASICBASEPARTYNAME>",
"      <NUMBERINGSTYLE>Automatic (Manual Override)</NUMBERINGSTYLE>",
"      <CSTFORMISSUETYPE>&#4; Not Applicable</CSTFORMISSUETYPE>",
"      <CSTFORMRECVTYPE>&#4; Not Applicable</CSTFORMRECVTYPE>",
"      <FBTPAYMENTTYPE>Default</FBTPAYMENTTYPE>",
"      <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>",
"      <VCHSTATUSTAXADJUSTMENT>Default</VCHSTATUSTAXADJUSTMENT>",
"      <VCHSTATUSVOUCHERTYPE>{{vt}}</VCHSTATUSVOUCHERTYPE>",
"      <VCHSTATUSTAXUNIT>Odisha Registration</VCHSTATUSTAXUNIT>",
"      <VCHGSTCLASS>&#4; Not Applicable</VCHGSTCLASS>",
"?pan|      <BUYERPINNUMBER>{{pan}}</BUYERPINNUMBER>",
"?consigneePan|      <CONSIGNEEPINNUMBER>{{consigneePan}}</CONSIGNEEPINNUMBER>",
"      <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>",
"      <VOUCHERTYPEORIGNAME>{{vt}}</VOUCHERTYPEORIGNAME>",
"      <DIFFACTUALQTY>No</DIFFACTUALQTY>",
"      <ISMSTFROMSYNC>No</ISMSTFROMSYNC>",
"      <ISDELETED>No</ISDELETED>",
"      <ISSECURITYONWHENENTERED>No</ISSECURITYONWHENENTERED>",
"      <ASORIGINAL>No</ASORIGINAL>",
"      <AUDITED>No</AUDITED>",
"      <ISCOMMONPARTY>No</ISCOMMONPARTY>",
"      <FORJOBCOSTING>No</FORJOBCOSTING>",
"      <ISOPTIONAL>No</ISOPTIONAL>",
"      <EFFECTIVEDATE>{{date}}</EFFECTIVEDATE>",
"      <USEFOREXCISE>No</USEFOREXCISE>",
"      <ISFORJOBWORKIN>No</ISFORJOBWORKIN>",
"      <ALLOWCONSUMPTION>No</ALLOWCONSUMPTION>",
"      <USEFORINTEREST>No</USEFORINTEREST>",
"      <USEFORGAINLOSS>No</USEFORGAINLOSS>",
"      <USEFORGODOWNTRANSFER>No</USEFORGODOWNTRANSFER>",
"      <USEFORCOMPOUND>No</USEFORCOMPOUND>",
"      <USEFORSERVICETAX>No</USEFORSERVICETAX>",
"      <ISREVERSECHARGEAPPLICABLE>No</ISREVERSECHARGEAPPLICABLE>",
"      <ISSYSTEM>No</ISSYSTEM>",
"      <ISFETCHEDONLY>No</ISFETCHEDONLY>",
"      <ISGSTOVERRIDDEN>No</ISGSTOVERRIDDEN>",
"      <ISCANCELLED>No</ISCANCELLED>",
"      <ISONHOLD>No</ISONHOLD>",
"      <ISSUMMARY>No</ISSUMMARY>",
"      <ISECOMMERCESUPPLY>No</ISECOMMERCESUPPLY>",
"      <ISBOENOTAPPLICABLE>No</ISBOENOTAPPLICABLE>",
"      <ISGSTSECSEVENAPPLICABLE>No</ISGSTSECSEVENAPPLICABLE>",
"      <IGNOREEINVVALIDATION>No</IGNOREEINVVALIDATION>",
"      <CMPGSTISOTHTERRITORYASSESSEE>No</CMPGSTISOTHTERRITORYASSESSEE>",
"      <PARTYGSTISOTHTERRITORYASSESSEE>No</PARTYGSTISOTHTERRITORYASSESSEE>",
"      <IRNJSONEXPORTED>No</IRNJSONEXPORTED>",
"      <IRNCANCELLED>No</IRNCANCELLED>",
"      <IGNOREGSTCONFLICTINMIG>No</IGNOREGSTCONFLICTINMIG>",
"      <ISOPBALTRANSACTION>No</ISOPBALTRANSACTION>",
"      <IGNOREGSTFORMATVALIDATION>No</IGNOREGSTFORMATVALIDATION>",
"      <ISELIGIBLEFORITC>Yes</ISELIGIBLEFORITC>",
"      <IGNOREGSTOPTIONALUNCERTAIN>No</IGNOREGSTOPTIONALUNCERTAIN>",
"      <ISGSTREFUND>No</ISGSTREFUND>",
"      <ISEWAYBILLEXCLUDED>No</ISEWAYBILLEXCLUDED>",
"      <ISBUYERPEPPOLREGISTERED>No</ISBUYERPEPPOLREGISTERED>",
"      <ISVATOVERRIDDEN>No</ISVATOVERRIDDEN>",
"      <ISEINVOVERRIDDEN>No</ISEINVOVERRIDDEN>",
"      <UPDATESUMMARYVALUES>No</UPDATESUMMARYVALUES>",
"      <ISEWAYBILLAPPLICABLE>No</ISEWAYBILLAPPLICABLE>",
"      <ISDELETEDRETAINED>No</ISDELETEDRETAINED>",
"      <ISNULL>No</ISNULL>",
"      <ISEXCISEVOUCHER>No</ISEXCISEVOUCHER>",
"      <EXCISETAXOVERRIDE>No</EXCISETAXOVERRIDE>",
"      <USEFORTAXUNITTRANSFER>No</USEFORTAXUNITTRANSFER>",
"      <ISEXER1NOPOVERWRITE>No</ISEXER1NOPOVERWRITE>",
"      <ISEXF2NOPOVERWRITE>No</ISEXF2NOPOVERWRITE>",
"      <ISEXER3NOPOVERWRITE>No</ISEXER3NOPOVERWRITE>",
"      <IGNOREPOSVALIDATION>No</IGNOREPOSVALIDATION>",
"      <EXCISEOPENING>No</EXCISEOPENING>",
"      <USEFORFINALPRODUCTION>No</USEFORFINALPRODUCTION>",
"      <ISTDSOVERRIDDEN>No</ISTDSOVERRIDDEN>",
"      <ISTCSOVERRIDDEN>No</ISTCSOVERRIDDEN>",
"      <ISTDSTCSCASHVCH>No</ISTDSTCSCASHVCH>",
"      <INCLUDEADVPYMTVCH>No</INCLUDEADVPYMTVCH>",
"      <ISSUBWORKSCONTRACT>No</ISSUBWORKSCONTRACT>",
"      <IGNOREORIGVCHDATE>No</IGNOREORIGVCHDATE>",
"      <ISVATPAIDATCUSTOMS>No</ISVATPAIDATCUSTOMS>",
"      <ISDECLAREDTOCUSTOMS>No</ISDECLAREDTOCUSTOMS>",
"      <VATADVANCEPAYMENT>No</VATADVANCEPAYMENT>",
"      <VATADVPAY>No</VATADVPAY>",
"      <ISCSTDELCAREDGOODSSALES>No</ISCSTDELCAREDGOODSSALES>",
"      <ISVATRESTAXINV>No</ISVATRESTAXINV>",
"      <ISSERVICETAXOVERRIDDEN>No</ISSERVICETAXOVERRIDDEN>",
"      <ISISDVOUCHER>No</ISISDVOUCHER>",
"      <ISEXCISEOVERRIDDEN>No</ISEXCISEOVERRIDDEN>",
"      <ISEXCISESUPPLYVCH>No</ISEXCISESUPPLYVCH>",
"      <GSTNOTEXPORTED>No</GSTNOTEXPORTED>",
"      <IGNOREGSTINVALIDATION>No</IGNOREGSTINVALIDATION>",
"      <OVRDNEWAYBILLAPPLICABILITY>No</OVRDNEWAYBILLAPPLICABILITY>",
"      <ISVATPRINCIPALACCOUNT>No</ISVATPRINCIPALACCOUNT>",
"      <VCHSTATUSISVCHNUMUSED>No</VCHSTATUSISVCHNUMUSED>",
"      <VCHGSTSTATUSISINCLUDED>Yes</VCHGSTSTATUSISINCLUDED>",
"      <VCHGSTSTATUSISUNCERTAIN>No</VCHGSTSTATUSISUNCERTAIN>",
"      <VCHGSTSTATUSISEXCLUDED>No</VCHGSTSTATUSISEXCLUDED>",
"      <VCHGSTSTATUSISAPPLICABLE>Yes</VCHGSTSTATUSISAPPLICABLE>",
"      <VCHGSTSTATUSISGSTR2BRECONCILED>No</VCHGSTSTATUSISGSTR2BRECONCILED>",
"      <VCHGSTSTATUSISGSTR2BONLYINPORTAL>No</VCHGSTSTATUSISGSTR2BONLYINPORTAL>",
"      <VCHGSTSTATUSISGSTR2BONLYINBOOKS>No</VCHGSTSTATUSISGSTR2BONLYINBOOKS>",
"      <VCHGSTSTATUSISGSTR2BMISMATCH>No</VCHGSTSTATUSISGSTR2BMISMATCH>",
"      <VCHGSTSTATUSISGSTR2BINDIFFPERIOD>No</VCHGSTSTATUSISGSTR2BINDIFFPERIOD>",
"      <VCHGSTSTATUSISRETEFFDATEOVERRDN>No</VCHGSTSTATUSISRETEFFDATEOVERRDN>",
"      <VCHGSTSTATUSISOVERRDN>No</VCHGSTSTATUSISOVERRDN>",
"      <VCHGSTSTATUSISSTATINDIFFDATE>No</VCHGSTSTATUSISSTATINDIFFDATE>",
"      <VCHGSTSTATUSISRETINDIFFDATE>No</VCHGSTSTATUSISRETINDIFFDATE>",
"      <VCHGSTSTATUSMAINSECTIONEXCLUDED>No</VCHGSTSTATUSMAINSECTIONEXCLUDED>",
"      <VCHGSTSTATUSISBRANCHTRANSFEROUT>No</VCHGSTSTATUSISBRANCHTRANSFEROUT>",
"      <VCHGSTSTATUSISSYSTEMSUMMARY>No</VCHGSTSTATUSISSYSTEMSUMMARY>",
"      <VCHSTATUSISUNREGISTEREDRCM>No</VCHSTATUSISUNREGISTEREDRCM>",
"      <VCHSTATUSISOPTIONAL>No</VCHSTATUSISOPTIONAL>",
"      <VCHSTATUSISCANCELLED>No</VCHSTATUSISCANCELLED>",
"      <VCHSTATUSISDELETED>No</VCHSTATUSISDELETED>",
"      <VCHSTATUSISOPENINGBALANCE>No</VCHSTATUSISOPENINGBALANCE>",
"      <VCHSTATUSISFETCHEDONLY>No</VCHSTATUSISFETCHEDONLY>",
"      <VCHGSTSTATUSISOPTIONALUNCERTAIN>No</VCHGSTSTATUSISOPTIONALUNCERTAIN>",
"      <VCHSTATUSISREACCEPTFORHSNDONE>No</VCHSTATUSISREACCEPTFORHSNDONE>",
"      <VCHSTATUSISREACCEPHSNSIXONEDONE>Yes</VCHSTATUSISREACCEPHSNSIXONEDONE>",
"      <PAYMENTLINKHASMULTIREF>No</PAYMENTLINKHASMULTIREF>",
"      <ISSHIPPINGWITHINSTATE>No</ISSHIPPINGWITHINSTATE>",
"      <ISOVERSEASTOURISTTRANS>No</ISOVERSEASTOURISTTRANS>",
"      <ISDESIGNATEDZONEPARTY>No</ISDESIGNATEDZONEPARTY>",
"      <HASCASHFLOW>No</HASCASHFLOW>",
"      <ISPOSTDATED>No</ISPOSTDATED>",
"      <USETRACKINGNUMBER>No</USETRACKINGNUMBER>",
"      <ISINVOICE>Yes</ISINVOICE>",
"      <MFGJOURNAL>No</MFGJOURNAL>",
"      <HASDISCOUNTS>No</HASDISCOUNTS>",
"      <ASPAYSLIP>No</ASPAYSLIP>",
"      <ISCOSTCENTRE>No</ISCOSTCENTRE>",
"      <ISSTXNONREALIZEDVCH>No</ISSTXNONREALIZEDVCH>",
"      <ISEXCISEMANUFACTURERON>No</ISEXCISEMANUFACTURERON>",
"      <ISBLANKCHEQUE>No</ISBLANKCHEQUE>",
"      <ISVOID>No</ISVOID>",
"      <ORDERLINESTATUS>No</ORDERLINESTATUS>",
"      <VATISAGNSTCANCSALES>No</VATISAGNSTCANCSALES>",
"      <VATISPURCEXEMPTED>No</VATISPURCEXEMPTED>",
"      <ISVATRESTAXINVOICE>No</ISVATRESTAXINVOICE>",
"      <VATISASSESABLECALCVCH>No</VATISASSESABLECALCVCH>",
"      <ISVATDUTYPAID>Yes</ISVATDUTYPAID>",
"      <ISDELIVERYSAMEASCONSIGNEE>No</ISDELIVERYSAMEASCONSIGNEE>",
"      <ISDISPATCHSAMEASCONSIGNOR>No</ISDISPATCHSAMEASCONSIGNOR>",
"      <ISDELETEDVCHRETAINED>No</ISDELETEDVCHRETAINED>",
"      <VCHONLYADDLINFOUPDATED>No</VCHONLYADDLINFOUPDATED>",
"      <CHANGEVCHMODE>No</CHANGEVCHMODE>",
"      <UAEEINVISBILLPREPAIDAMTOVRDN>No</UAEEINVISBILLPREPAIDAMTOVRDN>",
"      <RESETIRNQRCODE>No</RESETIRNQRCODE>",
"      <ISVCHEXCHANGED>No</ISVCHEXCHANGED>",
"?alterId|      <ALTERID> {{alterId}}</ALTERID>",
"?masterId|      <MASTERID> {{masterId}}</MASTERID>",
"?voucherKey|      <VOUCHERKEY>{{voucherKey}}</VOUCHERKEY>",
"?retainKey|      <VOUCHERRETAINKEY>{{retainKey}}</VOUCHERRETAINKEY>",
"      <VOUCHERNUMBERSERIES>Default</VOUCHERNUMBERSERIES>",
"      <EWAYBILLDETAILS.LIST>      </EWAYBILLDETAILS.LIST>",
"      <EXCLUDEDTAXATIONS.LIST>      </EXCLUDEDTAXATIONS.LIST>",
"      <OLDAUDITENTRIES.LIST>      </OLDAUDITENTRIES.LIST>",
"      <ACCOUNTAUDITENTRIES.LIST>      </ACCOUNTAUDITENTRIES.LIST>",
"      <AUDITENTRIES.LIST>      </AUDITENTRIES.LIST>",
"      <DUTYHEADDETAILS.LIST>      </DUTYHEADDETAILS.LIST>",
"      <GSTADVADJDETAILS.LIST>      </GSTADVADJDETAILS.LIST>",
"      <ALLINVENTORYENTRIES.LIST>",
"       <STOCKITEMNAME>{{item}}</STOCKITEMNAME>",
"       <GSTOVRDNISREVCHARGEAPPL>&#4; Not Applicable</GSTOVRDNISREVCHARGEAPPL>",
"       <GSTOVRDNTAXABILITY>{{taxability}}</GSTOVRDNTAXABILITY>",
"       <GSTSOURCETYPE>Ledger</GSTSOURCETYPE>",
"       <GSTLEDGERSOURCE>{{sales}}</GSTLEDGERSOURCE>",
"       <HSNSOURCETYPE>Ledger</HSNSOURCETYPE>",
"       <HSNLEDGERSOURCE>{{sales}}</HSNLEDGERSOURCE>",
"       <GSTOVRDNSTOREDNATURE/>",
"       <GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>",
"       <GSTRATEINFERAPPLICABILITY>As per Masters/Company</GSTRATEINFERAPPLICABILITY>",
"       <GSTHSNNAME>{{hsn}}</GSTHSNNAME>",
"?hsnDescription|       <GSTHSNDESCRIPTION>{{hsnDescription}}</GSTHSNDESCRIPTION>",
"       <GSTHSNINFERAPPLICABILITY>As per Masters/Company</GSTHSNINFERAPPLICABILITY>",
"       <GSTOVRDNISTAXONMRPAPPLICABLE>&#4; Not Applicable</GSTOVRDNISTAXONMRPAPPLICABLE>",
"       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
"       <ISRCMAPPLICABLE>No</ISRCMAPPLICABLE>",
"       <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>",
"       <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>",
"       <CONTENTNEGISPOS>No</CONTENTNEGISPOS>",
"       <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>",
"       <ISAUTONEGATE>No</ISAUTONEGATE>",
"       <ISCUSTOMSCLEARANCE>No</ISCUSTOMSCLEARANCE>",
"       <ISTRACKCOMPONENT>No</ISTRACKCOMPONENT>",
"       <ISTRACKPRODUCTION>No</ISTRACKPRODUCTION>",
"       <ISPRIMARYITEM>No</ISPRIMARYITEM>",
"       <ISSCRAP>No</ISSCRAP>",
"       <RATE>{{rate}}/LTR</RATE>",
"       <AMOUNT>{{itemAmount}}</AMOUNT>",
"       <ACTUALQTY> {{qty}} LTR</ACTUALQTY>",
"       <BILLEDQTY> {{qty}} LTR</BILLEDQTY>",
"       <BATCHALLOCATIONS.LIST>",
"        <GODOWNNAME>Main Location</GODOWNNAME>",
"        <BATCHNAME>Primary Batch</BATCHNAME>",
"        <INDENTNO>&#4; Not Applicable</INDENTNO>",
"        <ORDERNO>&#4; Not Applicable</ORDERNO>",
"        <TRACKINGNUMBER>&#4; Not Applicable</TRACKINGNUMBER>",
"        <DYNAMICCSTISCLEARED>No</DYNAMICCSTISCLEARED>",
"        <AMOUNT>{{itemAmount}}</AMOUNT>",
"        <ACTUALQTY> {{qty}} LTR</ACTUALQTY>",
"        <BILLEDQTY> {{qty}} LTR</BILLEDQTY>",
"        <ADDITIONALDETAILS.LIST>        </ADDITIONALDETAILS.LIST>",
"        <VOUCHERCOMPONENTLIST.LIST>        </VOUCHERCOMPONENTLIST.LIST>",
"       </BATCHALLOCATIONS.LIST>",
"       <ACCOUNTINGALLOCATIONS.LIST>",
"        <OLDAUDITENTRYIDS.LIST TYPE=\"Number\">",
"         <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>",
"        </OLDAUDITENTRYIDS.LIST>",
"        <LEDGERNAME>{{sales}}</LEDGERNAME>",
"        <GSTCLASS>&#4; Not Applicable</GSTCLASS>",
"        <GSTOVRDNISTAXONMRPAPPLICABLE>&#4; Not Applicable</GSTOVRDNISTAXONMRPAPPLICABLE>",
"        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
"        <LEDGERFROMITEM>No</LEDGERFROMITEM>",
"        <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>",
"        <ISRCMAPPLICABLE>No</ISRCMAPPLICABLE>",
"        <ISSYSTEM>No</ISSYSTEM>",
"        <ISPARTYLEDGER>No</ISPARTYLEDGER>",
"        <GSTOVERRIDDEN>No</GSTOVERRIDDEN>",
"        <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>",
"        <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>",
"        <STRDGSTISPARTYLEDGER>No</STRDGSTISPARTYLEDGER>",
"        <STRDGSTISDUTYLEDGER>No</STRDGSTISDUTYLEDGER>",
"        <CONTENTNEGISPOS>No</CONTENTNEGISPOS>",
"        <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>",
"        <ISCAPVATTAXALTERED>No</ISCAPVATTAXALTERED>",
"        <ISCAPVATNOTCLAIMED>No</ISCAPVATNOTCLAIMED>",
"        <AMOUNT>{{itemAmount}}</AMOUNT>",
"        <SERVICETAXDETAILS.LIST>        </SERVICETAXDETAILS.LIST>",
"        <BANKALLOCATIONS.LIST>        </BANKALLOCATIONS.LIST>",
"        <BILLALLOCATIONS.LIST>        </BILLALLOCATIONS.LIST>",
"        <INTERESTCOLLECTION.LIST>        </INTERESTCOLLECTION.LIST>",
"        <OLDAUDITENTRIES.LIST>        </OLDAUDITENTRIES.LIST>",
"        <ACCOUNTAUDITENTRIES.LIST>        </ACCOUNTAUDITENTRIES.LIST>",
"        <AUDITENTRIES.LIST>        </AUDITENTRIES.LIST>",
"        <INPUTCRALLOCS.LIST>        </INPUTCRALLOCS.LIST>",
"        <DUTYHEADDETAILS.LIST>        </DUTYHEADDETAILS.LIST>",
"        <EXCISEDUTYHEADDETAILS.LIST>        </EXCISEDUTYHEADDETAILS.LIST>",
"        <RATEDETAILS.LIST>        </RATEDETAILS.LIST>",
"        <SUMMARYALLOCS.LIST>        </SUMMARYALLOCS.LIST>",
"        <CENVATDUTYALLOCATIONS.LIST>        </CENVATDUTYALLOCATIONS.LIST>",
"        <STPYMTDETAILS.LIST>        </STPYMTDETAILS.LIST>",
"        <EXCISEPAYMENTALLOCATIONS.LIST>        </EXCISEPAYMENTALLOCATIONS.LIST>",
"        <TAXBILLALLOCATIONS.LIST>        </TAXBILLALLOCATIONS.LIST>",
"        <TAXOBJECTALLOCATIONS.LIST>        </TAXOBJECTALLOCATIONS.LIST>",
"        <TDSEXPENSEALLOCATIONS.LIST>        </TDSEXPENSEALLOCATIONS.LIST>",
"        <VATSTATUTORYDETAILS.LIST>        </VATSTATUTORYDETAILS.LIST>",
"        <COSTTRACKALLOCATIONS.LIST>        </COSTTRACKALLOCATIONS.LIST>",
"        <REFVOUCHERDETAILS.LIST>        </REFVOUCHERDETAILS.LIST>",
"        <INVOICEWISEDETAILS.LIST>        </INVOICEWISEDETAILS.LIST>",
"        <VATITCDETAILS.LIST>        </VATITCDETAILS.LIST>",
"        <ADVANCETAXDETAILS.LIST>        </ADVANCETAXDETAILS.LIST>",
"        <TAXTYPEALLOCATIONS.LIST>        </TAXTYPEALLOCATIONS.LIST>",
"       </ACCOUNTINGALLOCATIONS.LIST>",
"       <DUTYHEADDETAILS.LIST>       </DUTYHEADDETAILS.LIST>",
"       <RATEDETAILS.LIST>",
"        <GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD>",
"        <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>",
"       </RATEDETAILS.LIST>",
"       <RATEDETAILS.LIST>",
"        <GSTRATEDUTYHEAD>SGST/UTGST</GSTRATEDUTYHEAD>",
"        <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>",
"       </RATEDETAILS.LIST>",
"       <RATEDETAILS.LIST>",
"        <GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD>",
"        <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>",
"       </RATEDETAILS.LIST>",
"       <RATEDETAILS.LIST>",
"        <GSTRATEDUTYHEAD>Cess</GSTRATEDUTYHEAD>",
"        <GSTRATEVALUATIONTYPE>&#4; Not Applicable</GSTRATEVALUATIONTYPE>",
"       </RATEDETAILS.LIST>",
"       <RATEDETAILS.LIST>",
"        <GSTRATEDUTYHEAD>State Cess</GSTRATEDUTYHEAD>",
"        <GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE>",
"       </RATEDETAILS.LIST>",
"       <SUPPLEMENTARYDUTYHEADDETAILS.LIST>       </SUPPLEMENTARYDUTYHEADDETAILS.LIST>",
"       <TAXOBJECTALLOCATIONS.LIST>       </TAXOBJECTALLOCATIONS.LIST>",
"       <REFVOUCHERDETAILS.LIST>       </REFVOUCHERDETAILS.LIST>",
"       <EXCISEALLOCATIONS.LIST>       </EXCISEALLOCATIONS.LIST>",
"       <EXPENSEALLOCATIONS.LIST>       </EXPENSEALLOCATIONS.LIST>",
"      </ALLINVENTORYENTRIES.LIST>",
"      <CONTRITRANS.LIST>      </CONTRITRANS.LIST>",
"      <EWAYBILLERRORLIST.LIST>      </EWAYBILLERRORLIST.LIST>",
"      <IRNERRORLIST.LIST>      </IRNERRORLIST.LIST>",
"      <ADVADJUSTMENTREFERENCEDETAILS.LIST>      </ADVADJUSTMENTREFERENCEDETAILS.LIST>",
"      <HARYANAVAT.LIST>      </HARYANAVAT.LIST>",
"      <SUPPLEMENTARYDUTYHEADDETAILS.LIST>      </SUPPLEMENTARYDUTYHEADDETAILS.LIST>",
"      <INVOICEDELNOTES.LIST>      </INVOICEDELNOTES.LIST>",
"      <INVOICEORDERLIST.LIST>      </INVOICEORDERLIST.LIST>",
"      <INVOICEINDENTLIST.LIST>      </INVOICEINDENTLIST.LIST>",
"      <ATTENDANCEENTRIES.LIST>      </ATTENDANCEENTRIES.LIST>",
"      <ORIGINVOICEDETAILS.LIST>      </ORIGINVOICEDETAILS.LIST>",
"      <INVOICEEXPORTLIST.LIST>      </INVOICEEXPORTLIST.LIST>",
"      <LEDGERENTRIES.LIST>",
"       <OLDAUDITENTRYIDS.LIST TYPE=\"Number\">",
"        <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>",
"       </OLDAUDITENTRYIDS.LIST>",
"       <LEDGERNAME>{{party}}</LEDGERNAME>",
"       <GSTCLASS>&#4; Not Applicable</GSTCLASS>",
"       <GSTOVRDNISTAXONMRPAPPLICABLE>&#4; Not Applicable</GSTOVRDNISTAXONMRPAPPLICABLE>",
"       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>",
"       <LEDGERFROMITEM>No</LEDGERFROMITEM>",
"       <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>",
"       <ISRCMAPPLICABLE>No</ISRCMAPPLICABLE>",
"       <ISSYSTEM>No</ISSYSTEM>",
"       <ISPARTYLEDGER>Yes</ISPARTYLEDGER>",
"       <GSTOVERRIDDEN>No</GSTOVERRIDDEN>",
"       <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>",
"       <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>",
"       <STRDGSTISPARTYLEDGER>No</STRDGSTISPARTYLEDGER>",
"       <STRDGSTISDUTYLEDGER>No</STRDGSTISDUTYLEDGER>",
"       <CONTENTNEGISPOS>No</CONTENTNEGISPOS>",
"       <ISLASTDEEMEDPOSITIVE>Yes</ISLASTDEEMEDPOSITIVE>",
"       <ISCAPVATTAXALTERED>No</ISCAPVATTAXALTERED>",
"       <ISCAPVATNOTCLAIMED>No</ISCAPVATNOTCLAIMED>",
"       <AMOUNT>{{partyAmount}}</AMOUNT>",
"       <SERVICETAXDETAILS.LIST>       </SERVICETAXDETAILS.LIST>",
"       <BANKALLOCATIONS.LIST>       </BANKALLOCATIONS.LIST>",
"       <BILLALLOCATIONS.LIST>       </BILLALLOCATIONS.LIST>",
"       <INTERESTCOLLECTION.LIST>       </INTERESTCOLLECTION.LIST>",
"       <OLDAUDITENTRIES.LIST>       </OLDAUDITENTRIES.LIST>",
"       <ACCOUNTAUDITENTRIES.LIST>       </ACCOUNTAUDITENTRIES.LIST>",
"       <AUDITENTRIES.LIST>       </AUDITENTRIES.LIST>",
"       <INPUTCRALLOCS.LIST>       </INPUTCRALLOCS.LIST>",
"       <DUTYHEADDETAILS.LIST>       </DUTYHEADDETAILS.LIST>",
"       <EXCISEDUTYHEADDETAILS.LIST>       </EXCISEDUTYHEADDETAILS.LIST>",
"       <RATEDETAILS.LIST>       </RATEDETAILS.LIST>",
"       <SUMMARYALLOCS.LIST>       </SUMMARYALLOCS.LIST>",
"       <CENVATDUTYALLOCATIONS.LIST>       </CENVATDUTYALLOCATIONS.LIST>",
"       <STPYMTDETAILS.LIST>       </STPYMTDETAILS.LIST>",
"       <EXCISEPAYMENTALLOCATIONS.LIST>       </EXCISEPAYMENTALLOCATIONS.LIST>",
"       <TAXBILLALLOCATIONS.LIST>       </TAXBILLALLOCATIONS.LIST>",
"       <TAXOBJECTALLOCATIONS.LIST>       </TAXOBJECTALLOCATIONS.LIST>",
"       <TDSEXPENSEALLOCATIONS.LIST>       </TDSEXPENSEALLOCATIONS.LIST>",
"       <VATSTATUTORYDETAILS.LIST>       </VATSTATUTORYDETAILS.LIST>",
"       <COSTTRACKALLOCATIONS.LIST>       </COSTTRACKALLOCATIONS.LIST>",
"       <REFVOUCHERDETAILS.LIST>       </REFVOUCHERDETAILS.LIST>",
"       <INVOICEWISEDETAILS.LIST>       </INVOICEWISEDETAILS.LIST>",
"       <VATITCDETAILS.LIST>       </VATITCDETAILS.LIST>",
"       <ADVANCETAXDETAILS.LIST>       </ADVANCETAXDETAILS.LIST>",
"       <TAXTYPEALLOCATIONS.LIST>       </TAXTYPEALLOCATIONS.LIST>",
"      </LEDGERENTRIES.LIST>",
"@ROFF",
"      <GST.LIST>",
"       <PURPOSETYPE>GST</PURPOSETYPE>",
"       <STAT.LIST>",
"        <PURPOSETYPE>GST</PURPOSETYPE>",
"        <STATKEY>&#4; Auto Stat Number</STATKEY>",
"        <ISFETCHEDONLY>No</ISFETCHEDONLY>",
"        <ISDELETED>No</ISDELETED>",
"        <TALLYCONTENTUSER.LIST>        </TALLYCONTENTUSER.LIST>",
"       </STAT.LIST>",
"      </GST.LIST>",
"      <UAEVAT.LIST>      </UAEVAT.LIST>",
"      <STKJRNLADDLCOSTDETAILS.LIST>      </STKJRNLADDLCOSTDETAILS.LIST>",
"      <PAYROLLMODEOFPAYMENT.LIST>      </PAYROLLMODEOFPAYMENT.LIST>",
"      <ATTDRECORDS.LIST>      </ATTDRECORDS.LIST>",
"      <GSTEWAYCONSIGNORADDRESS.LIST>      </GSTEWAYCONSIGNORADDRESS.LIST>",
"      <GSTEWAYCONSIGNEEADDRESS.LIST>      </GSTEWAYCONSIGNEEADDRESS.LIST>",
"      <TEMPGSTRATEDETAILS.LIST>      </TEMPGSTRATEDETAILS.LIST>",
"      <TEMPGSTADVADJUSTED.LIST>      </TEMPGSTADVADJUSTED.LIST>",
"      <GSTBUYERADDRESS.LIST>      </GSTBUYERADDRESS.LIST>",
"      <GSTCONSIGNEEADDRESS.LIST>      </GSTCONSIGNEEADDRESS.LIST>",
"@VEHICLE",
"     </VOUCHER>"
];
// The round-off ledger line, when the customer amount was rounded.
var ROFF = [
"      <LEDGERENTRIES.LIST>",
"       <OLDAUDITENTRYIDS.LIST TYPE=\"Number\">",
"        <OLDAUDITENTRYIDS>-1</OLDAUDITENTRYIDS>",
"       </OLDAUDITENTRYIDS.LIST>",
"       <LEDGERNAME>R/off</LEDGERNAME>",
"       <GSTCLASS>&#4; Not Applicable</GSTCLASS>",
"       <GSTOVRDNISTAXONMRPAPPLICABLE>&#4; Not Applicable</GSTOVRDNISTAXONMRPAPPLICABLE>",
"       <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>",
"       <LEDGERFROMITEM>No</LEDGERFROMITEM>",
"       <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>",
"       <ISRCMAPPLICABLE>No</ISRCMAPPLICABLE>",
"       <ISSYSTEM>No</ISSYSTEM>",
"       <ISPARTYLEDGER>No</ISPARTYLEDGER>",
"       <GSTOVERRIDDEN>No</GSTOVERRIDDEN>",
"       <ISGSTASSESSABLEVALUEOVERRIDDEN>No</ISGSTASSESSABLEVALUEOVERRIDDEN>",
"       <STRDISGSTAPPLICABLE>No</STRDISGSTAPPLICABLE>",
"       <STRDGSTISPARTYLEDGER>No</STRDGSTISPARTYLEDGER>",
"       <STRDGSTISDUTYLEDGER>No</STRDGSTISDUTYLEDGER>",
"       <CONTENTNEGISPOS>No</CONTENTNEGISPOS>",
"       <ISLASTDEEMEDPOSITIVE>No</ISLASTDEEMEDPOSITIVE>",
"       <ISCAPVATTAXALTERED>No</ISCAPVATTAXALTERED>",
"       <ISCAPVATNOTCLAIMED>No</ISCAPVATNOTCLAIMED>",
"       <AMOUNT>{{roff}}</AMOUNT>",
"       <VATEXPAMOUNT>{{roff}}</VATEXPAMOUNT>",
"       <SERVICETAXDETAILS.LIST>       </SERVICETAXDETAILS.LIST>",
"       <BANKALLOCATIONS.LIST>       </BANKALLOCATIONS.LIST>",
"       <BILLALLOCATIONS.LIST>       </BILLALLOCATIONS.LIST>",
"       <INTERESTCOLLECTION.LIST>       </INTERESTCOLLECTION.LIST>",
"       <OLDAUDITENTRIES.LIST>       </OLDAUDITENTRIES.LIST>",
"       <ACCOUNTAUDITENTRIES.LIST>       </ACCOUNTAUDITENTRIES.LIST>",
"       <AUDITENTRIES.LIST>       </AUDITENTRIES.LIST>",
"       <INPUTCRALLOCS.LIST>       </INPUTCRALLOCS.LIST>",
"       <DUTYHEADDETAILS.LIST>       </DUTYHEADDETAILS.LIST>",
"       <EXCISEDUTYHEADDETAILS.LIST>       </EXCISEDUTYHEADDETAILS.LIST>",
"       <RATEDETAILS.LIST>       </RATEDETAILS.LIST>",
"       <SUMMARYALLOCS.LIST>       </SUMMARYALLOCS.LIST>",
"       <CENVATDUTYALLOCATIONS.LIST>       </CENVATDUTYALLOCATIONS.LIST>",
"       <STPYMTDETAILS.LIST>       </STPYMTDETAILS.LIST>",
"       <EXCISEPAYMENTALLOCATIONS.LIST>       </EXCISEPAYMENTALLOCATIONS.LIST>",
"       <TAXBILLALLOCATIONS.LIST>       </TAXBILLALLOCATIONS.LIST>",
"       <TAXOBJECTALLOCATIONS.LIST>       </TAXOBJECTALLOCATIONS.LIST>",
"       <TDSEXPENSEALLOCATIONS.LIST>       </TDSEXPENSEALLOCATIONS.LIST>",
"       <VATSTATUTORYDETAILS.LIST>       </VATSTATUTORYDETAILS.LIST>",
"       <COSTTRACKALLOCATIONS.LIST>       </COSTTRACKALLOCATIONS.LIST>",
"       <REFVOUCHERDETAILS.LIST>       </REFVOUCHERDETAILS.LIST>",
"       <INVOICEWISEDETAILS.LIST>       </INVOICEWISEDETAILS.LIST>",
"       <VATITCDETAILS.LIST>       </VATITCDETAILS.LIST>",
"       <ADVANCETAXDETAILS.LIST>       </ADVANCETAXDETAILS.LIST>",
"       <TAXTYPEALLOCATIONS.LIST>       </TAXTYPEALLOCATIONS.LIST>",
"      </LEDGERENTRIES.LIST>"
];

function esc(s){
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function money(n){ return (Math.round(Number(n || 0) * 100) / 100).toFixed(2); }
function numPart(s){ var m = String(s == null ? "" : s).match(/(\d+)\s*$/); return m ? Number(m[1]) : 0; }

// v: {seriesKey, number, dateISO, party, vehicle, qty, rate, itemAmt, partyAmt, roff,
//     party master: {gstin, regType, state, place, pincode, country, address[], pan, consigneePan, vatDealerType},
//     Tally identity when known: guid, alterId (and masterId, voucherKey, retainKey, vchKey)}
function voucherLines(v){
  var s = SERIES[v.seriesKey] || SERIES.hsd, m = v.master || {};
  var state = m.state || "Odisha";
  var val = {
    date: String(v.dateISO || "").replace(/-/g, ""), guid: v.guid, regType: m.regType || "Unregistered/Consumer",
    vatDealerType: m.vatDealerType, state: state, country: m.country || "India", gstin: m.gstin,
    place: m.place || state, vt: s.vt, party: v.party, number: v.number, pincode: m.pincode, pan: m.pan,
    consigneePan: m.consigneePan === undefined ? m.pan : m.consigneePan,
    alterId: v.alterId, masterId: v.masterId, voucherKey: v.voucherKey, retainKey: v.retainKey,
    item: s.item, taxability: s.taxability, sales: s.sales, hsn: s.hsn, hsnDescription: s.hsnDescription,
    rate: money(v.rate), qty: Number(v.qty || 0).toFixed(3), itemAmount: money(v.itemAmt),
    partyAmount: money(-Number(v.partyAmt || 0)), roff: money(v.roff)
  };
  function fill(line){ return line.replace(/\{\{(\w+)\}\}/g, function(_, k){ return esc(val[k]); }); }
  var out = [], address = (m.address || []).filter(function(a){ return String(a || "").trim(); });
  VOUCHER.forEach(function(line){
    var cond = /^\?(\w+)\|/.exec(line);
    if (cond){
      if (val[cond[1]] === undefined || val[cond[1]] === null || val[cond[1]] === "") return;
      line = line.slice(cond[0].length);
    }
    if (line === "@VOUCHER"){
      out.push('     <VOUCHER' + (v.guid ? ' REMOTEID="' + esc(v.guid) + '"' : "") + (v.vchKey ? ' VCHKEY="' + esc(v.vchKey) + '"' : "")
        + ' VCHTYPE="' + esc(s.vt) + '" ACTION="Create" OBJVIEW="Invoice Voucher View">');
    } else if (line === "@ADDRESS"){
      if (!address.length) return;
      ["ADDRESS", "BASICBUYERADDRESS"].forEach(function(tag){
        out.push('      <' + tag + '.LIST TYPE="String">');
        address.forEach(function(a){ out.push('       <' + tag + '>' + esc(a) + '</' + tag + '>'); });
        out.push('      </' + tag + '.LIST>');
      });
    } else if (line === "@ROFF"){
      if (Math.round(Number(v.roff || 0) * 100)) ROFF.forEach(function(l){ out.push(fill(l)); });
    } else if (line === "@VEHICLE"){
      if (!v.vehicle) return;
      out.push('      <UDF:EIVEHNO.LIST DESC="`EiVehNo`" ISLIST="YES" TYPE="String" INDEX="120">');
      out.push('       <UDF:EIVEHNO DESC="`EiVehNo`">' + esc(v.vehicle) + '</UDF:EIVEHNO>');
      out.push('      </UDF:EIVEHNO.LIST>');
    } else {
      out.push(fill(line));
    }
  });
  return out;
}

// o: {company, companyGuid (the company's Tally GUID, when known), vouchers in Day Book order}
function xml(o){
  var x = ["<ENVELOPE>", " <HEADER>", "  <TALLYREQUEST>Import Data</TALLYREQUEST>", " </HEADER>", " <BODY>", "  <IMPORTDATA>",
    "   <REQUESTDESC>", "    <REPORTNAME>All Masters</REPORTNAME>", "    <STATICVARIABLES>",
    "     <SVCURRENTCOMPANY>" + esc(o.company) + "</SVCURRENTCOMPANY>", "    </STATICVARIABLES>", "   </REQUESTDESC>", "   <REQUESTDATA>"];
  o.vouchers.forEach(function(v){
    x.push('    <TALLYMESSAGE xmlns:UDF="TallyUDF">');
    x.push.apply(x, voucherLines(v));
    x.push("    </TALLYMESSAGE>");
  });
  if (o.companyGuid){
    x.push('    <TALLYMESSAGE xmlns:UDF="TallyUDF">', "     <COMPANY>", '      <REMOTECMPINFO.LIST MERGE="Yes">',
      "       <NAME>" + esc(o.companyGuid) + "</NAME>", "       <REMOTECMPNAME>" + esc(o.company) + "</REMOTECMPNAME>",
      "       <REMOTECMPSTATE>" + esc(o.companyState || "Odisha") + "</REMOTECMPSTATE>", "      </REMOTECMPINFO.LIST>",
      "     </COMPANY>", "    </TALLYMESSAGE>");
  }
  x.push("   </REQUESTDATA>", "  </IMPORTDATA>", " </BODY>", "</ENVELOPE>");
  return x.join("\r\n") + "\r\n";
}

// Tally writes its XML as UTF-16 little-endian with a byte order mark.
function utf16(text){
  var out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xFF; out[1] = 0xFE;
  for (var i = 0; i < text.length; i++){
    var c = text.charCodeAt(i);
    out[2 + i * 2] = c & 0xFF;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

// The Day Book's order: the order the vouchers were entered in Tally. A
// voucher's Tally GUID ends in a counter Tally gives each new voucher, so the
// vouchers the bridge has linked take Tally's own order; the others keep their
// place by when they were saved in the app.
var GUID_COUNTER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([0-9a-f]+)$/i;
function daybookOrder(list){
  var out = list.slice().sort(function(a, b){
    return String(a.dateISO).localeCompare(String(b.dateISO)) || (a.createdAt || 0) - (b.createdAt || 0)
      || ORDER.indexOf(a.seriesKey) - ORDER.indexOf(b.seriesKey) || numPart(a.number) - numPart(b.number);
  });
  var counter = function(v){ var m = GUID_COUNTER.exec(v.guid || ""); return m ? parseInt(m[1], 16) : null; };
  var slots = [], linked = [];
  out.forEach(function(v, i){ if (counter(v) !== null){ slots.push(i); linked.push(v); } });
  linked.sort(function(a, b){ return String(a.dateISO).localeCompare(String(b.dateISO)) || counter(a) - counter(b); });
  slots.forEach(function(i, k){ out[i] = linked[k]; });
  return out;
}
// The Excel export's order: by voucher type, then number.
function registerOrder(list){
  return list.slice().sort(function(a, b){
    return String(a.dateISO).localeCompare(String(b.dateISO)) || ORDER.indexOf(a.seriesKey) - ORDER.indexOf(b.seriesKey)
      || numPart(a.number) - numPart(b.number);
  });
}

/* ---------------- Excel ---------------- */

var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// 2026-10-22 -> 22-Oct-26 (Tally's date style)
function tallyDate(iso){
  var p = String(iso).split("-");
  return Number(p[2]) + "-" + MONTHS[Number(p[1]) - 1] + "-" + p[0].slice(2);
}
// Excel's serial day number (1900 system)
function serial(iso){
  var p = String(iso).split("-");
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000 + 25569;
}
function num(n, places){ return String(Number(Number(n || 0).toFixed(places))); }

// Tally's export, as saved by Excel: fonts (Arial 9/12), rules, number formats.
var STYLES = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" mc:Ignorable=\"x14ac x16r2 xr\" xmlns:x14ac=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac\" xmlns:x16r2=\"http://schemas.microsoft.com/office/spreadsheetml/2015/02/main\" xmlns:xr=\"http://schemas.microsoft.com/office/spreadsheetml/2014/revision\"><numFmts count=\"3\"><numFmt numFmtId=\"164\" formatCode=\"&quot;&quot;0.000&quot; LTR&quot;\"/><numFmt numFmtId=\"165\" formatCode=\"&quot;&quot;0.00\"/><numFmt numFmtId=\"166\" formatCode=\"&quot;&quot;0\"/></numFmts><fonts count=\"5\" x14ac:knownFonts=\"1\"><font><sz val=\"11\"/><color theme=\"1\"/><name val=\"Calibri\"/><family val=\"2\"/><scheme val=\"minor\"/></font><font><sz val=\"10\"/><color theme=\"1\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><b/><sz val=\"12\"/><color theme=\"1\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><sz val=\"9\"/><color theme=\"1\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><b/><sz val=\"9\"/><color theme=\"1\"/><name val=\"Arial\"/><family val=\"2\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"4\"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style=\"thin\"><color indexed=\"64\"/></bottom><diagonal/></border><border><left/><right/><top style=\"thin\"><color indexed=\"64\"/></top><bottom/><diagonal/></border><border><left/><right/><top style=\"thin\"><color indexed=\"64\"/></top><bottom style=\"thin\"><color indexed=\"64\"/></bottom><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"26\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"2\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"2\" fillId=\"0\" borderId=\"2\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"2\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"4\" fillId=\"0\" borderId=\"2\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"top\" indent=\"5\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"2\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"2\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"4\" fillId=\"0\" borderId=\"2\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"4\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"top\" indent=\"5\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"center\" vertical=\"top\"/></xf><xf numFmtId=\"15\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"4\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"164\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"165\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"165\" fontId=\"4\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"166\" fontId=\"4\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"49\" fontId=\"4\" fillId=\"0\" borderId=\"3\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"top\"/></xf><xf numFmtId=\"165\" fontId=\"4\" fillId=\"0\" borderId=\"3\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf><xf numFmtId=\"166\" fontId=\"4\" fillId=\"0\" borderId=\"3\" xfId=\"0\" applyNumberFormat=\"1\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"top\"/></xf></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles><dxfs count=\"0\"/><tableStyles count=\"0\" defaultTableStyle=\"TableStyleMedium2\" defaultPivotStyle=\"PivotStyleLight16\"/><extLst><ext uri=\"{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}\" xmlns:x14=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main\"><x14:slicerStyles defaultSlicerStyle=\"SlicerStyleLight1\"/></ext><ext uri=\"{9260A510-F301-46a8-8635-F512D64BE5F5}\" xmlns:x15=\"http://schemas.microsoft.com/office/spreadsheetml/2010/11/main\"><x15:timelineStyles defaultTimelineStyle=\"TimeSlicerStyleLight1\"/></ext></extLst></styleSheet>";

// o: {heading: [company, address lines…], day (ISO), vouchers} -> {path: text} of the .xlsx package
function excelParts(o){
  var strings = [], index = {}, refs = 0;
  function sst(t){
    t = String(t == null ? "" : t);
    refs++;
    if (!(t in index)){ index[t] = strings.length; strings.push(t); }
    return index[t];
  }
  var rows = [];
  function row(r, cells, ht){
    rows.push('<row r="' + r + '" spans="1:9"' + (ht ? ' ht="' + ht + '"' : "") + ' x14ac:dyDescent="0.25">' + cells.join("") + "</row>");
  }
  var COLS = "ABCDEFGHI";
  function s(col, r, style, text){ return '<c r="' + col + r + '" s="' + style + '" t="s"><v>' + sst(text) + "</v></c>"; }
  function n(col, r, style, value){ return '<c r="' + col + r + '" s="' + style + '"><v>' + value + "</v></c>"; }
  function blank(col, r, style){ return '<c r="' + col + r + '" s="' + style + '"/>'; }
  function rest(r, from, style){ var out = []; for (var i = COLS.indexOf(from); i < 9; i++) out.push(blank(COLS[i], r, style)); return out; }

  // heading: company (bold 12), address (9), e-mail over a rule, report name, period
  var head = o.heading || [];
  var lines = [[head[0] || "", 2], [head[1] || "", 3], [head[2] || "", 3], [head[3] || "", 3], [head[4] || "", 4],
    ["Sales Register", 5], ["For " + tallyDate(o.day), 3]];
  lines.forEach(function(l, i){
    var r = i + 1;
    row(r, [s("A", r, l[1], l[0]), blank("B", r, l[1]), blank("C", r, l[1])].concat(rest(r, "D", 1)), r === 1 || r === 6 ? "15.75" : null);
  });
  row(8, [s("A", 8, 6, "Date"), s("B", 8, 7, "Particulars"), s("C", 8, 8, "Vch Type"), s("D", 8, 9, "Qty"), s("E", 8, 9, "Rate"),
    s("F", 8, 8, "Vehicle"), s("G", 8, 6, "Vch No."), s("H", 8, 10, "Debit"), s("I", 8, 10, "Credit")]);
  row(9, [s("A", 9, 11, ""), s("B", 9, 12, ""), s("C", 9, 13, ""), s("D", 9, 14, ""), s("E", 9, 14, ""), s("F", 9, 13, ""),
    s("G", 9, 11, ""), s("H", 9, 11, "Amount"), s("I", 9, 11, "Amount")]);
  var total = 0, r = 10;
  registerOrder(o.vouchers).forEach(function(v){
    var debit = Number(Number(v.partyAmt || 0).toFixed(2));
    total += debit;
    row(r, [n("A", r, 15, serial(v.dateISO)), s("B", r, 16, v.party), s("C", r, 16, (SERIES[v.seriesKey] || SERIES.hsd).vt),
      n("D", r, 17, num(v.qty, 3)), n("E", r, 18, num(v.rate, 2)), s("F", r, 19, v.vehicle || ""), s("G", r, 20, String(v.number)),
      n("H", r, 21, num(debit, 2)), blank("I", r, 22)]);
    r++;
  });
  // the total, where Tally's export puts it
  row(r, [s("A", r, 23, "Total:"), blank("B", r, 23), blank("C", r, 23), blank("D", r, 23), n("E", r, 24, num(total, 2)),
    blank("F", r, 25)].concat(rest(r, "G", 1)));

  var NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  var X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  var sheet = X + '<worksheet ' + NS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
    + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac"'
    + ' xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">'
    + '<dimension ref="A1:I' + r + '"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols>'
    + [8.7109375, 48, 10.7109375, 13.28515625, 10.42578125, 11.85546875, 7, 10.42578125, 7].map(function(w, i){
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" bestFit="1" customWidth="1"/>';
    }).join("") + "</cols><sheetData>" + rows.join("") + "</sheetData>"
    + '<mergeCells count="8"><mergeCell ref="A7:C7"/><mergeCell ref="A' + r + ':D' + r + '"/><mergeCell ref="A1:C1"/><mergeCell ref="A2:C2"/>'
    + '<mergeCell ref="A3:C3"/><mergeCell ref="A4:C4"/><mergeCell ref="A5:C5"/><mergeCell ref="A6:C6"/></mergeCells>'
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
  var shared = X + '<sst ' + NS + ' count="' + refs + '" uniqueCount="' + strings.length + '">'
    + strings.map(function(t){
      return t === "" ? "<si><t/></si>" : "<si><t" + (/^\s|\s$/.test(t) ? ' xml:space="preserve"' : "") + ">" + esc(t) + "</t></si>";
    }).join("") + "</sst>";
  return {
    "[Content_Types].xml": X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    "_rels/.rels": X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "docProps/app.xml": X + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
      + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Vriddhi Fuels</Application>'
      + '<TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sales Register</vt:lpstr></vt:vector></TitlesOfParts></Properties>',
    "docProps/core.xml": X + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
      + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + "<dc:creator>Vriddhi Fuels</dc:creator></cp:coreProperties>",
    "xl/workbook.xml": X + '<workbook ' + NS + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<bookViews><workbookView xWindow="-120" yWindow="-120" windowWidth="29040" windowHeight="15720"/></bookViews>'
      + '<sheets><sheet name="Sales Register" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>',
    "xl/_rels/workbook.xml.rels": X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    "xl/styles.xml": STYLES,
    "xl/sharedStrings.xml": shared,
    "xl/worksheets/sheet1.xml": sheet
  };
}

/* A stored (uncompressed) zip of {path: text}, for the .xlsx package — no
   library to load, so the Excel download works offline too. */
var CRC = (function(){
  var t = [];
  for (var n = 0; n < 256; n++){
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();
function crc32(bytes){
  var c = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function zip(files){
  var enc = new TextEncoder(), local = [], central = [], offset = 0;
  function u16(n){ return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n){ return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
  var TIME = 0, DATE = (2026 - 1980) << 9 | 1 << 5 | 1;   // fixed stamp: the same input gives the same file
  Object.keys(files).forEach(function(path){
    var name = enc.encode(path), data = typeof files[path] === "string" ? enc.encode(files[path]) : files[path];
    var crc = crc32(data);
    var common = [].concat(u16(20), u16(0x0800), u16(0), u16(TIME), u16(DATE), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
    local.push(new Uint8Array([].concat(u32(0x04034B50), common)), name, data);
    central.push(new Uint8Array([].concat(u32(0x02014B50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
    offset += 30 + name.length + data.length;
  });
  var size = central.reduce(function(n, b){ return n + b.length; }, 0), count = Object.keys(files).length;
  var parts = local.concat(central, [new Uint8Array([].concat(u32(0x06054B50), u16(0), u16(0), u16(count), u16(count), u32(size), u32(offset), u16(0)))]);
  var out = new Uint8Array(parts.reduce(function(n, b){ return n + b.length; }, 0)), at = 0;
  parts.forEach(function(b){ out.set(b, at); at += b.length; });
  return out;
}
// the .xlsx file itself
function excel(o){ return zip(excelParts(o)); }

var api = { SERIES: SERIES, xml: xml, voucherLines: voucherLines, utf16: utf16, excelParts: excelParts, excel: excel, zip: zip,
  daybookOrder: daybookOrder, registerOrder: registerOrder, tallyDate: tallyDate, serial: serial };
if (typeof module !== "undefined" && module.exports) module.exports = api;
else global.VFDayBook = api;

})(typeof window !== "undefined" ? window : this);
