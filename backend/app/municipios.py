"""Registro de municípios. Para adicionar um município, inclua uma linha aqui
e baixe o limite com scripts/fetch_boundaries.py."""

MUNICIPIOS = {
    4305959: "Cotiporã",
    4307864: "Fagundes Varela",
    4312351: "Montauri",
    4320404: "Serafina Corrêa",
    4322350: "União da Serra",
    4322806: "Veranópolis",
}

FONTE_LIMITES = {
    "nome": "IBGE – Malha Municipal (API de Malhas v3)",
    "url": "https://servicodados.ibge.gov.br/api/v3/malhas/municipios/",
    "licenca": "Dados públicos IBGE (CC BY 4.0)",
    "resolucao_espacial": "qualidade=maxima",
}
