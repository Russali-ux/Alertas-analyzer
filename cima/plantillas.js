/*
 * plantillas.js — Estructura de cada documento por país y tipo.
 *
 * Cada sección toma su contenido de uno o varios campos del segmentador
 * (a … e.6, f, g.x, x.*). Para agregar Colombia o México basta con completar
 * su entrada en PAISES (activo:true) y su bloque en PLANTILLAS.
 *
 *   fuentes : [{ campo, rotulo? }]   campos que alimentan la sección (en orden)
 *   manual  : { es, pt }             sección sin fuente: se deja un recuadro para completar
 *   nota    : { es, pt }             indicación para quien edita (no se exporta)
 *   critica : true                   se marca como sección crítica (seguridad)
 *   opcional: true                   solo se muestra si tiene contenido (p. ej. radiofármacos)
 *   grupo   : { es, pt }             encabezado de grupo que se muestra antes de la sección
 */
(function (global) {
  'use strict';

  const PAISES = [
    { codigo: 'PE', nombre: 'Perú',     autoridad: 'DIGEMID',  activo: true },
    { codigo: 'CO', nombre: 'Colombia', autoridad: 'INVIMA',   activo: false },
    { codigo: 'MX', nombre: 'México',   autoridad: 'COFEPRIS', activo: false },
  ];

  const IDIOMAS = [
    { codigo: 'es', nombre: 'Español (ES)' },
    { codigo: 'pt', nombre: 'Português (PT)' },
  ];

  const TIPOS = [
    { codigo: 'FT',       icono: '📄', nombre: { es: 'Ficha técnica', pt: 'Ficha técnica' },  accion: { es: 'Generar ficha técnica', pt: 'Gerar ficha técnica' } },
    { codigo: 'INSERTO',  icono: '📑', nombre: { es: 'Inserto',       pt: 'Bula' },           accion: { es: 'Generar inserto',       pt: 'Gerar bula' } },
    { codigo: 'ETIQUETA', icono: '🏷', nombre: { es: 'Etiqueta',      pt: 'Rótulo' },         accion: { es: 'Generar etiqueta',      pt: 'Gerar rótulo' } },
  ];

  const G = {
    intro:  { es: 'Introducción',               pt: 'Introdução' },
    clin:   { es: 'c. Información clínica',     pt: 'c. Informações clínicas' },
    farm:   { es: 'd. Propiedades farmacológicas', pt: 'd. Propriedades farmacológicas' },
    datos:  { es: 'e. Datos farmacéuticos',     pt: 'e. Dados farmacêuticos' },
    otros:  { es: 'Otros datos',                pt: 'Outros dados' },
  };
  const f = (campo, rotulo) => rotulo ? { campo, rotulo } : { campo };

  const PLANTILLAS = {
    PE: {
      // ── Estructura entregada por el usuario: "CONTENIDO DE LA FICHA TÉCNICA" ──
      FT: {
        norma: { es: 'DS 016-2011-SA · Contenido de la Ficha Técnica', pt: 'DS 016-2011-SA · Conteúdo da Ficha Técnica' },
        fuentePreferida: ['FT', 'P'],
        numerar: 'codigo',
        secciones: [
          { codigo: 'a',   grupo: G.intro, fuentes: [f('a')], titulo: { es: 'Nombre del medicamento, cantidad de IFA(s) y forma farmacéutica', pt: 'Nome do medicamento, quantidade de IFA(s) e forma farmacêutica' },
            nota: { es: 'Si contiene hasta 3 IFA(s), incluir la DCI (con su cantidad) de cada uno debajo del nombre.', pt: 'Se contiver até 3 IFA(s), incluir a DCI (com a quantidade) de cada um abaixo do nome.' } },
          { codigo: 'b',   fuentes: [f('b')], titulo: { es: 'Composición cualitativa-cuantitativa', pt: 'Composição qualitativa e quantitativa' } },
          { codigo: 'c.1', grupo: G.clin, fuentes: [f('c.1')], titulo: { es: 'Indicaciones terapéuticas', pt: 'Indicações terapêuticas' } },
          { codigo: 'c.2', fuentes: [f('c.2')], titulo: { es: 'Dosis y vía de administración', pt: 'Posologia e via de administração' } },
          { codigo: 'c.3', fuentes: [f('c.3')], critica: true, titulo: { es: 'Contraindicaciones', pt: 'Contraindicações' } },
          { codigo: 'c.4', fuentes: [f('c.4')], critica: true, titulo: { es: 'Advertencias y precauciones', pt: 'Advertências e precauções' } },
          { codigo: 'c.5', fuentes: [f('c.5')], critica: true, titulo: { es: 'Interacciones con otros medicamentos y otras formas de interacción', pt: 'Interações medicamentosas e outras formas de interação' } },
          { codigo: 'c.6', fuentes: [f('c.6')], titulo: { es: 'Administración durante el embarazo y lactancia', pt: 'Uso durante a gravidez e a lactação' } },
          { codigo: 'c.7', fuentes: [f('c.7')], titulo: { es: 'Efectos sobre la capacidad de conducir y usar maquinaria', pt: 'Efeitos sobre a capacidade de dirigir e operar máquinas' } },
          { codigo: 'c.8', fuentes: [f('c.8')], critica: true, titulo: { es: 'Reacciones adversas', pt: 'Reações adversas' } },
          { codigo: 'c.9', fuentes: [f('c.9')], critica: true, titulo: { es: 'Sobredosis y tratamiento', pt: 'Superdosagem e tratamento' } },
          { codigo: 'd.1', grupo: G.farm, fuentes: [f('d.1')], titulo: { es: 'Propiedades farmacodinámicas', pt: 'Propriedades farmacodinâmicas' } },
          { codigo: 'd.2', fuentes: [f('d.2')], titulo: { es: 'Propiedades farmacocinéticas', pt: 'Propriedades farmacocinéticas' } },
          { codigo: 'd.3', fuentes: [f('d.3')], titulo: { es: 'Datos preclínicos de seguridad', pt: 'Dados de segurança pré-clínicos' } },
          { codigo: 'e.1', grupo: G.datos, fuentes: [f('e.1')], titulo: { es: 'Lista de excipientes', pt: 'Lista de excipientes' } },
          { codigo: 'e.2', fuentes: [f('e.2')], titulo: { es: 'Incompatibilidades', pt: 'Incompatibilidades' } },
          { codigo: 'e.3', fuentes: [f('e.3')], titulo: { es: 'Tiempo de vida útil', pt: 'Prazo de validade' } },
          { codigo: 'e.4', fuentes: [f('e.4')], titulo: { es: 'Precauciones especiales de conservación', pt: 'Precauções especiais de conservação' } },
          { codigo: 'e.5', fuentes: [f('e.5')], titulo: { es: 'Naturaleza y contenido del envase', pt: 'Natureza e conteúdo da embalagem' } },
          { codigo: 'e.6', fuentes: [f('e.6')], titulo: { es: 'Precauciones especiales para eliminar el medicamento no utilizado o sus restos', pt: 'Precauções especiais para eliminação do medicamento não utilizado ou seus resíduos' } },
          { codigo: 'f',   grupo: G.otros, fuentes: [f('f')], titulo: { es: 'Fecha de revisión del texto de la ficha técnica', pt: 'Data de revisão do texto da ficha técnica' } },
          { codigo: 'g.1', opcional: true, fuentes: [f('g.1')], titulo: { es: 'Radiofármacos: dosimetría interna de la radiación', pt: 'Radiofármacos: dosimetria interna da radiação' } },
          { codigo: 'g.2', opcional: true, fuentes: [f('g.2')], titulo: { es: 'Radiofármacos: instrucciones de preparación extemporánea', pt: 'Radiofármacos: instruções de preparação extemporânea' } },
        ],
      },

      // ── BORRADOR: estructura provisional basada en el DS 016-2011-SA ─────────
      INSERTO: {
        borrador: true,
        norma: { es: 'DS 016-2011-SA · Inserto (estructura provisional)', pt: 'DS 016-2011-SA · Bula (estrutura provisória)' },
        fuentePreferida: ['P', 'FT'],     // el inserto se arma desde el prospecto (lenguaje para paciente)
        numerar: 'orden',
        secciones: [
          { fuentes: [f('a')], titulo: { es: 'Nombre del producto', pt: 'Nome do produto' } },
          { fuentes: [f('b'), f('e.1', { es: 'Excipientes', pt: 'Excipientes' })], titulo: { es: 'Composición', pt: 'Composição' } },
          { fuentes: [f('c.1')], titulo: { es: 'Indicaciones', pt: 'Indicações' } },
          { fuentes: [f('c.3')], critica: true, titulo: { es: 'Contraindicaciones', pt: 'Contraindicações' } },
          { fuentes: [f('c.4')], critica: true, titulo: { es: 'Advertencias y precauciones', pt: 'Advertências e precauções' } },
          { fuentes: [f('c.5')], critica: true, titulo: { es: 'Interacciones con otros medicamentos', pt: 'Interações medicamentosas' } },
          { fuentes: [f('c.6')], titulo: { es: 'Embarazo y lactancia', pt: 'Gravidez e lactação' } },
          { fuentes: [f('c.7')], titulo: { es: 'Efectos sobre la capacidad de conducir y usar máquinas', pt: 'Efeitos sobre a capacidade de dirigir e operar máquinas' } },
          { fuentes: [f('c.2')], titulo: { es: 'Posología y vía de administración', pt: 'Posologia e modo de usar' } },
          { fuentes: [f('c.9')], critica: true, titulo: { es: 'Sobredosis', pt: 'Superdosagem' } },
          { fuentes: [f('c.8')], critica: true, titulo: { es: 'Reacciones adversas', pt: 'Reações adversas' } },
          { fuentes: [f('e.4'), f('e.3', { es: 'Tiempo de vida útil', pt: 'Prazo de validade' })], titulo: { es: 'Condiciones de almacenamiento', pt: 'Condições de armazenamento' } },
          { fuentes: [f('e.5')], titulo: { es: 'Presentación', pt: 'Apresentação' } },
          { fuentes: [f('x.titular')], titulo: { es: 'Titular del registro y fabricante', pt: 'Titular do registro e fabricante' } },
          { fuentes: [f('f')], titulo: { es: 'Fecha de revisión', pt: 'Data de revisão' } },
        ],
      },

      // ── BORRADOR: rotulado, estructura provisional basada en el DS 016-2011-SA ─
      ETIQUETA: {
        borrador: true,
        norma: { es: 'DS 016-2011-SA · Rotulado (estructura provisional)', pt: 'DS 016-2011-SA · Rotulagem (estrutura provisória)' },
        fuentePreferida: ['FT', 'P'],
        numerar: 'orden',
        secciones: [
          { fuentes: [f('a')], titulo: { es: 'Nombre del producto, DCI, concentración y forma farmacéutica', pt: 'Nome do produto, DCI, concentração e forma farmacêutica' } },
          { fuentes: [f('b')], titulo: { es: 'Composición por unidad de dosis', pt: 'Composição por unidade de dose' } },
          { fuentes: [f('e.5')], titulo: { es: 'Contenido del envase / presentación', pt: 'Conteúdo da embalagem / apresentação' } },
          { fuentes: [f('c.2')], titulo: { es: 'Vía de administración', pt: 'Via de administração' },
            nota: { es: 'Resumir: el rotulado indica la vía, no la posología completa.', pt: 'Resumir: o rótulo indica a via, não a posologia completa.' } },
          { fuentes: [f('e.4')], titulo: { es: 'Condiciones de almacenamiento', pt: 'Condições de armazenamento' } },
          { critica: true, titulo: { es: 'Advertencias y leyendas de seguridad', pt: 'Advertências e frases de segurança' },
            manual: { es: 'Completar leyendas obligatorias (p. ej. "Manténgase fuera del alcance de los niños").', pt: 'Preencher as frases obrigatórias (p. ex. "Manter fora do alcance das crianças").' } },
          { titulo: { es: 'Condición de venta', pt: 'Condição de venda' },
            manual: { es: 'Completar: condición de venta autorizada.', pt: 'Preencher: condição de venda autorizada.' } },
          { titulo: { es: 'Número de Registro Sanitario', pt: 'Número do Registro Sanitário' },
            manual: { es: 'Completar: Nº de Registro Sanitario DIGEMID.', pt: 'Preencher: nº do Registro Sanitário DIGEMID.' } },
          { fuentes: [f('x.titular')], titulo: { es: 'Titular del registro sanitario y fabricante', pt: 'Titular do registro sanitário e fabricante' } },
          { titulo: { es: 'Número de lote y fecha de vencimiento', pt: 'Número do lote e data de validade' },
            manual: { es: 'Completar: se imprime en cada lote.', pt: 'Preencher: impresso em cada lote.' } },
        ],
      },
    },
  };

  // Textos de la vista del documento generado (la configuración queda en español).
  const TXT = {
    es: { secciones: 'secciones', criticas: 'críticas', pendientes: 'pendientes', critica: 'CRÍTICA', pendiente: 'PENDIENTE',
          completar: 'COMPLETAR', exportar: 'Exportar Word', imprimir: 'Imprimir', expandir: 'Expandir todo', contraer: 'Contraer todo',
          fuente: 'Fuente', generado: 'Generado', idioma: 'Español (ES)', sinContenido: 'Sin contenido en el documento de origen.',
          borrador: 'Estructura provisional basada en el DS 016-2011-SA: pendiente de validar con la estructura oficial.',
          aviso_pt: '' },
    pt: { secciones: 'seções', criticas: 'críticas', pendientes: 'pendentes', critica: 'CRÍTICA', pendiente: 'PENDENTE',
          completar: 'PREENCHER', exportar: 'Exportar Word', imprimir: 'Imprimir', expandir: 'Expandir tudo', contraer: 'Recolher tudo',
          fuente: 'Fonte', generado: 'Gerado', idioma: 'Português (PT)', sinContenido: 'Sem conteúdo no documento de origem.',
          borrador: 'Estrutura provisória baseada no DS 016-2011-SA: pendente de validação com a estrutura oficial.',
          aviso_pt: 'Títulos em português. O conteúdo permanece em espanhol: o CIMA publica os documentos apenas em espanhol.' },
  };

  global.Plantillas = { PAISES, IDIOMAS, TIPOS, PLANTILLAS, TXT };
})(window);
