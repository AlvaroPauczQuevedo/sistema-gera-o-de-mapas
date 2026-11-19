# Gêmeos Digitais Regionais — Fase 1 (em andamento)

Municípios: Serafina Corrêa, União da Serra, Montauri, Fagundes Varela, Veranópolis, Cotiporã.

Arquitetura gratuita e sem servidor: os dados são baixados por scripts Python, salvos como
GeoJSON em `frontend/public/data/` e exibidos por um site estático (React + CesiumJS).

## Rodar localmente
    cd frontend && npm install && npm run dev      # http://localhost:5173

Relevo 3D: crie um token gratuito em https://ion.cesium.com e coloque em `frontend/.env`:

    VITE_CESIUM_TOKEN=seu_token

Sem token, o mapa funciona, mas sem relevo.

## Atualizar os dados
    cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
    .venv/Scripts/python scripts/fetch_boundaries.py   # limites IBGE
    .venv/Scripts/python scripts/fetch_osm.py          # ruas, rios, edificações (OSM)
    .venv/Scripts/python scripts/fetch_osm_pois.py     # instituições e estruturas de emergência (OSM)
    .venv/Scripts/python scripts/build_slope.py        # altitude e declividade (Copernicus GLO-30)

Os scripts do OSM retomam de onde pararam; use `--refazer` para baixar tudo de novo.

Novo município: incluir em `backend/app/municipios.py` e `frontend/public/data/municipios.json`, e rodar os scripts.

## Monitoramento (Modo 2)
    backend/.venv/Scripts/python backend/scripts/collect_monitoring.py

Gera `frontend/public/data/monitoramento.json` (não versionado) com:
- **CEMADEN**: chuva acumulada (1 h a 96 h) dos pluviômetros dos municípios. Horário da fonte em UTC.
- **ANA**: nível e chuva das estações telemétricas a até 25 km dos limites (48 h). Horário da fonte em Brasília.
- **Open-Meteo**: previsão de chuva e vento 72 h por município — modelo numérico, **não é previsão oficial**.

Todos os horários são gravados em UTC. Cada fonte tem situação (conectada/indisponível) e horário da última
coleta bem-sucedida; se uma fonte falha, os últimos dados são mantidos e marcados. Na tela, cada dado mostra
a idade: recente (até 2 h), atrasado (2–24 h) ou desatualizado (> 24 h).

O INMET (apitempo.inmet.gov.br) não respondeu nos testes; fica pendente.
O nível da ANA é bruto, na referência de cada estação; cotas de alerta ainda não cadastradas.

## Publicar (GitHub Pages, gratuito)
1. Envie o repositório ao GitHub.
2. Settings > Pages > Source: **GitHub Actions**.
3. Settings > Secrets and variables > Actions: crie o secret `VITE_CESIUM_TOKEN` e a variável `SITE_URL`.
   No Cesium ion, restrinja o token ao domínio do site (o token fica visível no navegador).

O workflow republica o site a cada 30 min com dados novos de monitoramento (grátis em repositório
público; em privado, aumente o intervalo — ver comentário em `.github/workflows/pages.yml`).

## Fontes
| Camada | Fonte | Licença |
|---|---|---|
| Limites municipais | IBGE, API de Malhas v3 (qualidade máxima) | CC BY 4.0 |
| Vias, rios, edificações, instituições | OpenStreetMap (Overpass API) | ODbL 1.0 |
| Altitude e declividade | Copernicus DEM GLO-30 (ESA), 30 m, via AWS Open Data | uso livre Copernicus |
| Relevo 3D na tela | Cesium World Terrain (plano gratuito) | termos Cesium ion |
| População e área | IBGE, Censo 2022 (tabela 4714) — `scripts/fetch_ibge_info.py` | CC BY 4.0 |
| Mapa de fundo | tiles do OpenStreetMap | ODbL; política de uso: em produção com muitos usuários, trocar por provedor próprio |

Limitações conhecidas:
- A cobertura do OSM é incompleta, sobretudo de edificações e instituições na zona rural. O que não está no OSM não aparece.
  Instituições vêm marcadas como "não verificado em campo".
- O GLO-30 é modelo de **superfície** (inclui copas e telhados): a declividade é indicativa e não substitui mapeamento geotécnico.
- Edificações: altura real só quando o OSM tem `height`; com `building:levels` a altura é aproximada (3 m por pavimento);
  sem nenhum dos dois, a edificação aparece plana, em cinza.

## Registros de campo (vistorias e ocorrências)
Aba **Campo** no Modo 1. Cada registro tem município (detectado pelas coordenadas), local, coordenadas (GPS com
precisão ou marcadas no mapa), data/hora, responsável, natureza, condição, descrição, fotos (reduzidas a 1280 px),
providências, situação e histórico de acompanhamento. Aparecem automaticamente na camada do mapa.

Ficam no **IndexedDB do aparelho** e funcionam sem internet. Ainda não há servidor central: a consolidação é por
exportação/importação GeoJSON (na importação prevalece a versão editada por último). Também exporta CSV.
O nome do responsável é dado pessoal — tratar os arquivos exportados conforme a LGPD.

O site é um PWA (instalável): sem conexão abre o app, os dados territoriais e os mapas já visitados.
Relevo 3D do Cesium ion e áreas de mapa nunca visitadas exigem conexão.

## Linha do tempo (Modo 2)
Últimas ~48 h observadas (ANA) + 72 h de previsão (modelo), em passos de 1 h. Play/pausa/parar/reiniciar,
±1 h, 0,5x–4x (1x = 1 h por segundo), intervalo de reprodução, marcadores de chuva ≥ 5 mm/h e comparação com
um momento A (variação de nível por estação). O trecho previsto é hachurado e etiquetado "PREVISÃO".

## Central regional
Painel executivo e comparação entre municípios, calculados a partir dos arquivos carregados; o que não existe
aparece como "pendente". Exporta CSV e imprime/PDF pelo navegador.

## Dados oficiais de risco e eventos históricos
    backend/.venv/Scripts/python backend/scripts/fetch_sgb_risco.py   # setores de risco geológico SGB/CPRM
    backend/.venv/Scripts/python backend/scripts/fetch_eventos.py     # cheias registradas pela ANA

- **SGB/CPRM** (setorização de risco alto e muito alto, mapeamento de fev/2025): Cotiporã 37 setores (~1.216 pessoas),
  Veranópolis 68 (~1.252 pessoas). Os outros 4 municípios não têm setorização publicada — isso não significa ausência de risco.
- **Eventos (ANA, estação 86472000 Linha José Júlio, Rio das Antas)**: set/2023 (subida 25,5 m), nov/2023 (17,2 m),
  mai/2024 (22,7 m — série com lacuna, provável falha do sensor no pico). Para incluir eventos, editar `EVENTOS` no script.

## Dados das prefeituras e saúde oficial
    backend/.venv/Scripts/python backend/scripts/fetch_cnes.py         # estabelecimentos de saúde (CNES, coordenadas oficiais)
    backend/.venv/Scripts/python backend/scripts/fetch_prefeituras.py  # secretarias e órgãos dos sites das prefeituras

- **CNES** (Ministério da Saúde): estabelecimentos públicos, SUS e de urgência com coordenadas oficiais. Telefone só
  dos públicos. Observação: na API, `offset` é o número da página.
- **Sites das prefeituras**: secretarias, unidades de saúde e órgãos (CRAS, CREAS, CAPS, Conselho Tutelar...) com
  endereço, telefone e horário. Posição obtida do endereço pelo Nominatim (aproximada, só aceita dentro do município;
  cache em `backend/data/geocode_cache.json`). E-mails não são coletados. Sites atrás de verificação antirrobô são
  registrados como inacessíveis — o script não contorna essas proteções.

## Análise histórica (Modo 4)
    backend/.venv/Scripts/python backend/scripts/fetch_atlas_desastres.py   # registros oficiais S2iD (Atlas Digital)

78 registros oficiais dos 6 municípios (1991–2025, Atlas Digital de Desastres / S2iD, MIDR): filtros por município,
tipo e período; totais de danos humanos, materiais e prejuízos; gráfico por ano; detalhe de cada registro;
exportação CSV. A tabela **Simulação × realidade** cruza cada cheia medida pela ANA com os registros oficiais dos
mesmos dias e com a última simulação do evento — base para calibrar o fator de correção e o limiar de deslizamentos.

Abrigos oficiais: os planos de contingência (PLANCON) dos municípios não são públicos (ficam no S2iD). A prefeitura
cadastra os abrigos pela aba Campo, natureza "Abrigo oficial / local de acolhimento" (com capacidade e telefone).

## Simulação de inundação (Modo 3) — ESTIMATIVA
    backend/.venv/Scripts/python backend/scripts/build_hand.py   # gera o modelo HAND (uma vez; ~1 min)

Método HAND (altura acima da drenagem mais próxima) sobre o Copernicus GLO-30, para Rio das Antas, Carreiro,
Guaporé e da Prata. Cenários: **evento histórico** (hidrograma real da ANA) ou **hipotético** (subida, tempo de pico,
recessão). Parâmetro editável **fator de correção local** para calibração por profissionais.
Mostra a lâmina d'água animada na linha do tempo, a profundidade estimada e os impactos no pico (área inundada,
edificações, vias, pontes e instituições do OSM, por município), compara com um cenário A, exporta GeoJSON e
mantém o histórico de execuções (neste aparelho).

**Movimentos de massa (estimativa por limiar):** setores SGB de encosta são "ativados" quando a chuva acumulada do
cenário atinge o limiar editável (risco muito alto: limiar; alto: 1,3 × limiar; valor inicial 100 mm, ilustrativo,
a calibrar com o histórico da região). Setores de erosão de margem ativam quando a água do rio chega até eles.
O painel mostra setores ativados e pessoas estimadas pelo SGB nesses setores. Não é modelo geotécnico.

**Animações (ilustração visual, podem ser desligadas):** nuvens 3D que escurecem com a chuva, chuva caindo com
intensidade da série do cenário (ANA a cada 15 min no evento real) e terra deslizando encosta abaixo nos setores
ativados mais próximos da câmera. A forma das animações não representa a física dos fenômenos.

Limitações (também na tela): sem hidrodinâmica, sem remanso, propagação de onda ou operação de barragens; mesma
subida em todo o trecho; relevo de superfície; contagens limitadas à cobertura do OSM; população exposta não estimada.
Não substitui HEC-RAS/HEC-HMS validados por profissional habilitado — a arquitetura permite trocar o HAND por
resultados importados desses modelos.

## Status
Feito: limites, vias, rios, edificações (3D quando há altura), instituições, altitude e declividade dos 6 municípios;
mapa 3D com camadas, seleção, estatísticas de relevo e procedência; monitoramento CEMADEN/ANA/previsão com
atualização automática; linha do tempo; registros de campo offline; central regional; PWA; layout para celular.

Também: setorização de risco SGB/CPRM; 3 eventos históricos de cheia (ANA); simulação de inundação por
estimativa (HAND) com animação, impactos, comparação e exportação.

Pendente: INMET; alertas oficiais (Defesa Civil RS); cotas de alerta das estações;
cheias medidas no Carreiro e Guaporé; histórico de monitoramento além de 48 h; servidor central
(sincronização, login, perfis, auditoria); importação de resultados HEC-RAS/HEC-HMS; modelo geotécnico de movimentos de
massa e vendavais; rotas e conectividade; relatórios PDF com mapa; assistente de IA.
