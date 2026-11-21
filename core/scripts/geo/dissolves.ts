/**
 * @fileoverview The countries whose admin 1 layer is below the level ISO
 * 3166-2 names first: France's departments, Italy's provinces, Spain's
 * provinces and Britain's local authorities. Each dissolves into its first
 * level by one admin 1 field, and each value of that field is one region:
 * its ISO 3166-2 code, then the English and local names Natural Earth does
 * not write for it.
 */

/** How one country's admin 1 features dissolve into its regions. */
export interface Dissolve {
  /** The admin 1 field whose value names a feature's region. */
  field: string;
  /** Each value: its region's ISO 3166-2 code, then its other names. */
  regions: Record<string, string[]>;
}

export const DISSOLVES: Record<string, Dissolve> = {
  FR: {
    field: 'region',
    regions: {
      'Auvergne-Rhône-Alpes': ['FR-ARA'],
      'Bourgogne-Franche-Comté': ['FR-BFC', 'Burgundy-Franche-Comté'],
      Bretagne: ['FR-BRE', 'Brittany'],
      'Centre-Val de Loire': ['FR-CVL'],
      Corse: ['FR-20R', 'Corsica'],
      'Grand Est': ['FR-GES'],
      Guadeloupe: ['FR-971'],
      'Guyane française': ['FR-973', 'French Guiana', 'Guyane'],
      'Hauts-de-France': ['FR-HDF'],
      'Île-de-France': ['FR-IDF'],
      Martinique: ['FR-972'],
      Mayotte: ['FR-976'],
      Normandie: ['FR-NOR', 'Normandy'],
      'Nouvelle-Aquitaine': ['FR-NAQ'],
      Occitanie: ['FR-OCC', 'Occitania'],
      'Pays de la Loire': ['FR-PDL'],
      "Provence-Alpes-Côte-d'Azur": ['FR-PAC'],
      Réunion: ['FR-974', 'La Réunion'],
    },
  },
  IT: {
    field: 'region',
    regions: {
      Abruzzo: ['IT-65'],
      Apulia: ['IT-75', 'Puglia'],
      Basilicata: ['IT-77'],
      Calabria: ['IT-78'],
      Campania: ['IT-72'],
      'Emilia-Romagna': ['IT-45'],
      'Friuli-Venezia Giulia': ['IT-36'],
      Lazio: ['IT-62', 'Latium'],
      Liguria: ['IT-42'],
      Lombardia: ['IT-25', 'Lombardy'],
      Marche: ['IT-57', 'Marches'],
      Molise: ['IT-67'],
      Piemonte: ['IT-21', 'Piedmont'],
      Sardegna: ['IT-88', 'Sardinia'],
      Sicily: ['IT-82', 'Sicilia'],
      Toscana: ['IT-52', 'Tuscany'],
      'Trentino-Alto Adige': ['IT-32', 'Trentino-South Tyrol'],
      Umbria: ['IT-55'],
      "Valle d'Aosta": ['IT-23', 'Aosta Valley'],
      Veneto: ['IT-34'],
    },
  },
  ES: {
    field: 'region',
    regions: {
      Andalucía: ['ES-AN', 'Andalusia'],
      Aragón: ['ES-AR'],
      Asturias: ['ES-AS'],
      'Canary Is.': ['ES-CN', 'Canary Islands', 'Canarias'],
      Cantabria: ['ES-CB'],
      'Castilla y León': ['ES-CL', 'Castile and León'],
      'Castilla-La Mancha': ['ES-CM', 'Castile-La Mancha'],
      Cataluña: ['ES-CT', 'Catalonia', 'Catalunya'],
      Ceuta: ['ES-CE'],
      Extremadura: ['ES-EX'],
      'Foral de Navarra': ['ES-NC', 'Navarra', 'Navarre'],
      Galicia: ['ES-GA'],
      'Islas Baleares': ['ES-IB', 'Balearic Islands', 'Illes Balears'],
      'La Rioja': ['ES-RI'],
      Madrid: ['ES-MD', 'Comunidad de Madrid'],
      Melilla: ['ES-ML'],
      Murcia: ['ES-MC', 'Región de Murcia'],
      'País Vasco': ['ES-PV', 'Basque Country', 'Euskadi'],
      Valenciana: ['ES-VC', 'Comunidad Valenciana', 'Valencian Community'],
    },
  },
  GB: {
    field: 'geonunit',
    regions: {
      England: ['GB-ENG', 'Inglaterra'],
      'Northern Ireland': ['GB-NIR', 'Irlanda del Norte', 'Irlanda do Norte'],
      Scotland: ['GB-SCT', 'Escocia', 'Escócia'],
      Wales: ['GB-WLS', 'Gales', 'País de Gales', 'Cymru'],
    },
  },
};
