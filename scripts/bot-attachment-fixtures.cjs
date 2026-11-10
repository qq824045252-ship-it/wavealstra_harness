const fs=require('node:fs'),path=require('node:path'),XLSX=require('xlsx');
exports.create=async root=>{
 fs.mkdirSync(root,{recursive:true});const cases=[];
 const add=(name,bytes,prompt,expected)=>{const file=path.join(root,name);fs.writeFileSync(file,bytes);cases.push({name,path:file,prompt,expected});};
 add('stock.csv','item,quantity\nAlpha,17\nBeta,29\n','请读库存附件，给两个品项和数量、合计数量。',['Alpha','17','Beta','29','46']);
 add('settings.json',JSON.stringify({service:'atlas',region:'west-3',replicas:4}),'请读配置附件，告诉我service、region和replicas。',['atlas','west-3','4']);
 const {Document,Paragraph,Packer}=require('docx');
 const doc=new Document({sections:[{children:[new Paragraph('Contract Kappa: warranty 27 months. Delivery 2030-04-16.')]}]});
 add('contract.docx',await Packer.toBuffer(doc),'请读合同附件，提取合同名、保修月份、交付日期。',['Kappa','27','2030-04-16']);
 const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['expense','amount'],['Train',73],['Hotel',126]]),'Expenses');
 add('expenses.xlsx',XLSX.write(wb,{type:'buffer',bookType:'xlsx'}),'请读费用附件，列明两项金额和合计。',['73','126','199']);
 const PptxGenJS=require('pptxgenjs');const slides=new PptxGenJS();
 for(const t of ['Project Nova','Milestone: prototype in June','Owner: Mira'])slides.addSlide().addText(t,{x:1,y:1,w:8,h:1});
 add('brief.pptx',await slides.write({outputType:'nodebuffer'}),'请读演示文稿附件，给出项目名、里程碑月份和负责人。',['Nova','June|六月|6月','Mira']);
 const stream='BT /F1 14 Tf 40 740 Td (Receipt R672. Total USD 83.50. Paid by cash.) Tj ET';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];let pdf='%PDF-1.4\n',offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}const start=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
 add('receipt.pdf',pdf,'请读收据附件，给收据号、总金额及币种、付款方式。',['R672','83.50','USD|美元','cash|现金']);return cases;
};
